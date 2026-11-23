import type { INestApplication } from '@nestjs/common';
import { unzipSync, strFromU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

/**
 * Phase 30, through the HTTP API: data import (upload, mapping with new custom fields, checks, duplicates, the
 * background run, the report and templates) for every kind of record, master data, and the permissions of the
 * Super Workspace, an HR Workspace and the Employee Workspace.
 */
describe('Data import, custom fields and master data', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let owner: string;
  let hrToken: string;
  let hrMember: { email: string; membershipId: string };
  let staffToken: string;
  let wsId: string;

  const csv = (rows: string[][]) => Buffer.from(rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n'));
  const upload = (token: string, type: string, rows: string[][], extra = '') =>
    api(app, token).post(`/imports?type=${type}${extra}`).attach('file', csv(rows), { filename: `${type}.csv`, contentType: 'text/csv' });
  const mapAll = (job: { suggestions: { column: number; field: string | null }[] }, over: Record<number, string | null> = {}) =>
    job.suggestions.map((s) => ({ column: s.column, field: s.column in over ? over[s.column]! : s.field }));
  const finish = async (token: string, id: string) => {
    for (let i = 0; i < 100; i++) {
      const j = await api(app, token).get(`/imports/${id}`);
      if (!['importing'].includes(j.body.status)) return j.body;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('import did not finish');
  };
  const sheets = (buf: Buffer) => {
    const files = unzipSync(new Uint8Array(buf));
    return [...strFromU8(files['xl/workbook.xml']!).matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
  };
  const binary = (res: { on: (e: string, cb: (c?: Buffer) => void) => void; setEncoding?: (e: string) => void }, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c?: Buffer) => chunks.push(c!));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  };

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool, { plan: 'business', standardLeaveTypes: true });
    owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    hrMember = await addMember(pool, t, { name: 'Hari Branch' });
    const staff = await addMember(pool, t, { name: 'Sana Staff' });
    const ws = await api(app, owner).post('/hr-workspaces').send({ name: 'Pune Branch', code: 'PUNE', kind: 'branch', features: ['leave', 'data_import'], adminMembershipIds: [hrMember.membershipId] });
    expect(ws.status, JSON.stringify(ws.body)).toBe(201);
    wsId = ws.body.id;
    hrToken = (await loginWithMfa(app, pool, hrMember.email)).accessToken;
    const hired = await api(app, owner).post('/employees').send({ legalEntityId: t.legalEntityId, firstName: 'Sana', lastName: 'Staff', dateOfJoining: '2022-01-10', probationMonths: 0, onboardingTemplateId: null, membershipId: staff.membershipId, employeeCode: 'EMP-STAFF' });
    expect(hired.status, JSON.stringify(hired.body)).toBe(201);
    staffToken = (await login(app, staff.email)).accessToken;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('master data', () => {
    it('lists every list, and adds, renames, disables and enables values with an audit trail', async () => {
      const lists = await api(app, owner).get('/master-data');
      expect(lists.status, JSON.stringify(lists.body)).toBe(200);
      expect(lists.body.map((l: { key: string }) => l.key)).toEqual(expect.arrayContaining(['industry', 'department', 'job_title', 'skill', 'candidate_source', 'employment_type']));
      const industries = await api(app, owner).get('/master-data/industry');
      expect(industries.status).toBe(200);
      expect(industries.body.items.length).toBeGreaterThan(5);
      const added = await api(app, owner).post('/master-data/industry').send({ label: 'Agritech', category: 'Technology' });
      expect(added.status, JSON.stringify(added.body)).toBe(201);
      expect((await api(app, owner).post('/master-data/industry').send({ label: 'agritech' })).status).toBe(409);
      const off = await api(app, owner).patch(`/master-data/industry/${added.body.id}`).send({ disabled: true });
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      const opts = await api(app, staffToken).get('/master-data/industry/options');
      expect(opts.status).toBe(200);
      expect(opts.body.map((o: { label: string }) => o.label)).not.toContain('Agritech');
      expect((await api(app, owner).patch(`/master-data/industry/${added.body.id}`).send({ disabled: false })).status).toBe(200);
      expect(await pool.count('audit_events', { tenant_id: t.id, resource_id: added.body.id, action: { $in: ['master_value.created', 'master_value.disabled', 'master_value.enabled'] } })).toBe(3);
      // Built-in lists cannot change; the Employee Workspace changes nothing.
      expect((await api(app, owner).post('/master-data/employment_type').send({ label: 'Gig' })).status).toBe(400);
      expect((await api(app, staffToken).post('/master-data/industry').send({ label: 'Space' })).status).toBe(403);
      expect((await api(app, staffToken).get('/master-data')).status).toBe(403);
    });
  });

  describe('employees, as the Super Workspace', () => {
    let jobId: string;

    it('gives a template with an instructions sheet', async () => {
      const r = await api(app, owner).get('/imports/templates/employees').buffer(true).parse(binary);
      expect(r.status).toBe(200);
      expect(sheets(r.body as Buffer)).toEqual(['Employees', 'Instructions']);
    });

    it('refuses an old .xls file with what to do instead', async () => {
      const xls = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(100)]);
      const r = await api(app, owner).post('/imports?type=employees').attach('file', xls, { filename: 'old.xls', contentType: 'application/vnd.ms-excel' });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('xls_not_supported');
    });

    it('reads the file, maps only sure columns, and offers close spellings for confirmation', async () => {
      const r = await upload(owner, 'employees', [
        ['Emp ID', 'Full Name', 'Email', 'DOJ', 'Departmnt', 'Reports To', 'Shirt size', 'Blood group', 'CL'],
        ['IMP-001', 'Asha Verma', 'asha.verma@imp.example', '05/04/2021', 'Data Science', '', 'M', 'B+', '6'],
        ['IMP-002', 'Ravi Kumar', 'ravi.kumar@imp.example', '2022-01-15', 'Data Science', 'IMP-001', 'L', 'O+', ''],
        ['IMP-003', 'Bad Date', 'bad.date@imp.example', '31/31/2020', '', '', 'S', '', ''],
        ['IMP-004', 'Bad Email', 'not-an-email', '2022-01-15', '', '', 'S', '', ''],
        ['EMP-STAFF', 'Sana Staff', '', '2022-01-10', '', '', 'M', '', ''],
      ]);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      jobId = r.body.id;
      expect(r.body).toMatchObject({ status: 'mapping', rowCount: 5, headers: expect.arrayContaining(['Shirt size']) });
      const s = (h: string) => r.body.suggestions.find((x: { header: string }) => x.header === h);
      expect(s('Emp ID')).toMatchObject({ field: 'employeeCode', confidence: 'exact' });
      expect(s('DOJ')).toMatchObject({ field: 'dateOfJoining', confidence: 'exact' });
      expect(s('Departmnt')).toMatchObject({ field: 'department', confidence: 'likely' });
      expect(s('Shirt size').field).toBeNull();
      // A close spelling is suggested but never mapped on its own.
      expect(r.body.mapping.find((m: { column: number }) => m.column === 4).field).toBeNull();
      expect(r.body.fields.map((f: { key: string }) => f.key)).toEqual(expect.arrayContaining(['employeeCode', 'leave:CL']));
      const guess = await api(app, owner).get(`/imports/${jobId}/columns/6/guess`);
      expect(guess.body).toMatchObject({ type: 'dropdown', options: ['L', 'M', 'S'] });
    });

    it('creates a field for a new column, checks every row and counts what will happen', async () => {
      const job = (await api(app, owner).get(`/imports/${jobId}`)).body;
      const r = await api(app, owner).put(`/imports/${jobId}/mapping`).send({
        mapping: mapAll(job, { 4: 'department', 5: 'managerCode', 6: null, 7: 'bloodGroup', 8: 'leave:CL' }),
        newFields: [{ column: 6, label: 'Shirt size', type: 'dropdown', options: ['S', 'M', 'L'], visibleToEmployee: false, searchable: true }],
        options: { duplicates: 'skip', matchBy: ['employeeCode', 'workEmail'], addMissingValues: true },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.status).toBe('validated');
      expect(r.body.createdFields).toEqual([{ key: 'shirt_size', label: 'Shirt size', column: 6 }]);
      const probs = (await api(app, owner).get(`/imports/${jobId}/rows?status=problems`)).body.rows;
      expect(r.body.summary, JSON.stringify(probs)).toMatchObject({ total: 5, errors: 2, duplicates: 1, new: 2 });
      const field = await pool.one('custom_fields', { tenant_id: t.id, key: 'shirt_size' });
      expect(field).toMatchObject({ entity: 'employee', type: 'dropdown', searchable: true, importable: true, view_roles: ['hr_workspace', 'super_workspace'] });
      const rows = (await api(app, owner).get(`/imports/${jobId}/rows?status=problems`)).body.rows;
      const of = (n: number) => rows.find((x: { row: number }) => x.row === n);
      expect(of(4).issues[0]).toMatchObject({ field: 'dateOfJoining', column: 'DOJ', level: 'error', suggestion: expect.stringContaining('day first') });
      expect(of(5).issues[0]).toMatchObject({ field: 'workEmail', level: 'error' });
      expect(of(6)).toMatchObject({ status: 'duplicate', decision: 'skip', match: { by: 'employeeCode', unique: true } });
      // The new department is a warning: it will be added to the list.
      expect((await api(app, owner).get(`/imports/${jobId}/rows?status=warning`)).body.rows[0].issues[0].message).toContain('Data Science is new');
    });

    it('imports the good rows in the background as real records, and reports the rest', async () => {
      const started = await api(app, owner).post(`/imports/${jobId}/run`);
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      const done = await finish(owner, jobId);
      expect(done.status).toBe('completed_with_errors');
      expect(done.summary).toMatchObject({ imported: 2, skipped: 1, failed: 2 });
      const asha = await pool.one('employees', { tenant_id: t.id, employee_code: 'IMP-001' });
      const ravi = await pool.one('employees', { tenant_id: t.id, employee_code: 'IMP-002' });
      expect(asha).toMatchObject({ first_name: 'Asha', last_name: 'Verma', work_email: 'asha.verma@imp.example', date_of_joining: '2021-04-05', joined_as: 'existing', source_import_id: jobId });
      expect(ravi!.current_manager_employee_id).toBe(asha!.id);
      const dept = await pool.one('departments', { tenant_id: t.id, name: 'Data Science' });
      expect(asha!.current_department_id).toBe(dept!.id);
      expect((await pool.one('employee_profiles', { tenant_id: t.id, employee_id: asha!.id }))!.blood_group).toBe('B+');
      const field = await pool.one('custom_fields', { tenant_id: t.id, key: 'shirt_size' });
      expect((await pool.one('custom_field_values', { tenant_id: t.id, field_id: field!.id, record_id: asha!.id }))!.value).toBe('m');
      // The imported employee works like any other: their profile opens, leave balance is there.
      const profile = await api(app, owner).get(`/employees/${asha!.id}`);
      expect(profile.status).toBe(200);
      expect(await pool.count('leave_ledger', { tenant_id: t.id, employee_id: asha!.id })).toBeGreaterThan(0);
      // The list can show what one import added.
      const list = await api(app, owner).get(`/employees?importId=${jobId}`);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(list.body.items.map((e: { employeeCode: string }) => e.employeeCode).sort()).toEqual(['IMP-001', 'IMP-002']);
      // Audit: upload, mapping, check, start, finish, and each record.
      for (const a of ['import.uploaded', 'import.mapped', 'import.validated', 'import.started', 'import.completed']) expect(await pool.count('audit_events', { tenant_id: t.id, resource_id: jobId, action: a }), a).toBe(1);
      expect(await pool.count('audit_events', { tenant_id: t.id, action: 'employee.created', resource_id: { $in: [asha!.id, ravi!.id] } })).toBe(2);
    });

    it('downloads a report with every problem and the rows to fix', async () => {
      const r = await api(app, owner).get(`/imports/${jobId}/report.xlsx`).buffer(true).parse(binary);
      expect(r.status).toBe(200);
      expect(sheets(r.body as Buffer)).toEqual(['Summary', 'Problems', 'Rows to fix', 'All rows']);
      const hist = await api(app, owner).get('/imports');
      expect(hist.body.map((j: { id: string }) => j.id)).toContain(jobId);
    });

    it('updates existing people when asked, row by row, and never adds a second person with the same ID', async () => {
      const r = await upload(owner, 'employees', [['Employee ID', 'First name', 'Last name', 'Phone', 'Date of joining'], ['IMP-001', 'Asha', 'Verma-Rao', '+91 98201 23456', '2021-04-05'], ['IMP-002', 'Ravi', 'Kumar', '', '2022-01-15']]);
      const id = r.body.id;
      const mapped = await api(app, owner).put(`/imports/${id}/mapping`).send({ mapping: mapAll(r.body), options: { duplicates: 'ask', matchBy: ['employeeCode'], addMissingValues: false } });
      expect(mapped.body).toMatchObject({ status: 'validated', undecided: 2, can: { run: false } });
      expect((await api(app, owner).post(`/imports/${id}/run`)).status).toBe(409);
      const bad = await api(app, owner).put(`/imports/${id}/decisions`).send({ decisions: [{ row: 2, decision: 'create' }] });
      expect(bad.status).toBe(422);
      const ok = await api(app, owner).put(`/imports/${id}/decisions`).send({ decisions: [{ row: 2, decision: 'update' }, { row: 3, decision: 'skip' }] });
      expect(ok.body).toMatchObject({ undecided: 0, can: { run: true } });
      await api(app, owner).post(`/imports/${id}/run`);
      const done = await finish(owner, id);
      expect(done.summary).toMatchObject({ updated: 1, skipped: 1, imported: 0 });
      const asha = await pool.one('employees', { tenant_id: t.id, employee_code: 'IMP-001' });
      expect(asha).toMatchObject({ last_name: 'Verma-Rao' });
      expect(asha!.phone).toMatch(/98201/);
      expect(await pool.count('employees', { tenant_id: t.id, employee_code: 'IMP-001' })).toBe(1);
    });

    it('flags the same employee ID twice in one file on both rows', async () => {
      const r = await upload(owner, 'employees', [['Employee ID', 'Full name', 'Date of joining'], ['IMP-009', 'One', '2021-01-01'], ['IMP-009', 'Two', '2021-01-01']]);
      const v = await api(app, owner).put(`/imports/${r.body.id}/mapping`).send({ mapping: mapAll(r.body), options: { duplicates: 'skip', matchBy: ['employeeCode'], addMissingValues: false } });
      expect(v.body.summary).toMatchObject({ errors: 2, new: 0 });
      const rows = (await api(app, owner).get(`/imports/${r.body.id}/rows?status=error`)).body.rows;
      expect(rows.map((x: { issues: { message: string }[] }) => x.issues[0]!.message)).toEqual(['IMP-009 is also on row 3', 'IMP-009 is also on row 2']);
      expect((await api(app, owner).post(`/imports/${r.body.id}/cancel`)).body.status).toBe('cancelled');
    });
    it('changes several people at once, and finds people by a searchable custom field', async () => {
      const asha = (await pool.one('employees', { tenant_id: t.id, employee_code: 'IMP-001' }))!;
      const ravi = (await pool.one('employees', { tenant_id: t.id, employee_code: 'IMP-002' }))!;
      const f = await api(app, owner).post('/custom-fields').send({ entity: 'employee', label: 'Badge number', type: 'short_text', searchable: true });
      expect(f.status, JSON.stringify(f.body)).toBe(201);
      const set = await api(app, owner).post('/employees/bulk').send({ action: 'custom_field', employeeIds: [asha.id], key: 'badge_number', value: 'BDG-7781' });
      expect(set.body, JSON.stringify(set.body)).toMatchObject({ done: 1, failed: 0 });
      const found = await api(app, owner).get('/employees?q=bdg-7781');
      expect(found.body.items.map((e: { employeeCode: string }) => e.employeeCode)).toEqual(['IMP-001']);
      const dept = await pool.one('departments', { tenant_id: t.id, name: 'Data Science' });
      const moved = await api(app, owner).post('/employees/bulk').send({ action: 'department', employeeIds: [asha.id, ravi.id, '00000000-0000-4000-8000-000000000001'], departmentId: null, effectiveFrom: new Date().toISOString().slice(0, 10) });
      expect(moved.body, JSON.stringify(moved.body)).toMatchObject({ done: 2, failed: 1 });
      expect((await pool.one('employees', { id: ravi.id }))!.current_department_id ?? null).toBeNull();
      expect(dept).toBeTruthy();
      expect((await api(app, staffToken).post('/employees/bulk').send({ action: 'department', employeeIds: [asha.id], departmentId: null, effectiveFrom: '2026-01-01' })).status).toBe(403);
      expect(await pool.count('audit_events', { tenant_id: t.id, action: 'employee.bulk_changed' })).toBe(2);
    });
  });

  describe('an HR Workspace', () => {
    it('imports into its own HR Workspace only, and cannot see the Super Workspace imports', async () => {
      const r = await upload(hrToken, 'employees', [['Employee ID', 'Full name', 'Date of joining', 'HR Workspace'], ['PUNE-01', 'Pooja Pune', '2023-03-01', '']]);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const central = await api(app, hrToken).put(`/imports/${r.body.id}/mapping`).send({ mapping: mapAll(r.body), options: { duplicates: 'skip', matchBy: ['employeeCode'], addMissingValues: true, hrWorkspaceId: null } });
      expect(central.status).toBe(403);
      const m = await api(app, hrToken).put(`/imports/${r.body.id}/mapping`).send({ mapping: mapAll(r.body), options: { duplicates: 'skip', matchBy: ['employeeCode'], addMissingValues: true } });
      expect(m.status, JSON.stringify(m.body)).toBe(200);
      await api(app, hrToken).post(`/imports/${r.body.id}/run`);
      const done = await finish(hrToken, r.body.id);
      expect(done.summary.imported, JSON.stringify(done)).toBe(1);
      expect((await pool.one('employees', { tenant_id: t.id, employee_code: 'PUNE-01' }))!.hr_workspace_id).toBe(wsId);
      // The Super Workspace sees every import; the HR Workspace only its own.
      const mine = (await api(app, hrToken).get('/imports')).body.map((j: { id: string }) => j.id);
      expect(mine).toEqual([r.body.id]);
      const superJobs = (await api(app, owner).get('/imports')).body.map((j: { id: string }) => j.id);
      expect(superJobs).toContain(r.body.id);
      expect((await api(app, hrToken).get(`/imports/${superJobs.find((x: string) => x !== r.body.id)}`)).status).toBe(404);
      // Only the Super Workspace places people by an HR Workspace column.
      const w = await upload(hrToken, 'employees', [['Employee ID', 'Full name', 'Date of joining', 'HR Workspace'], ['PUNE-02', 'Pia Pune', '2023-03-01', 'Pune Branch']]);
      const v = await api(app, hrToken).put(`/imports/${w.body.id}/mapping`).send({ mapping: mapAll(w.body), options: { duplicates: 'skip', matchBy: ['employeeCode'], addMissingValues: true } });
      expect(v.body.summary.errors).toBe(1);
    });

    it('cannot add values to company-wide master data, so unknown values are errors with a suggestion', async () => {
      const r = await upload(hrToken, 'employees', [['Employee ID', 'Full name', 'Date of joining', 'Skills'], ['PUNE-03', 'Pari Pune', '2023-03-01', 'Pythn']]);
      const v = await api(app, hrToken).put(`/imports/${r.body.id}/mapping`).send({ mapping: mapAll(r.body), options: { duplicates: 'skip', matchBy: ['employeeCode'], addMissingValues: true } });
      expect(v.body.summary.errors).toBe(1);
      const row = (await api(app, hrToken).get(`/imports/${r.body.id}/rows?status=error`)).body.rows[0];
      expect(row.issues[0]).toMatchObject({ field: 'skills', suggestion: 'Did you mean Python?' });
    });

    it('loses import when the Super Workspace switches it off for that HR Workspace, enforced by the server', async () => {
      const d = await api(app, owner).get(`/hr-workspaces/${wsId}`);
      expect(d.body.permissions.find((p: { key: string }) => p.key === 'imports:run')).toMatchObject({ on: true, locked: false });
      expect((await api(app, hrToken).put(`/hr-workspaces/${wsId}/permissions`).send({ changes: [{ key: 'imports:run', enabled: true }], version: d.body.version })).status).toBe(403);
      const off = await api(app, owner).put(`/hr-workspaces/${wsId}/permissions`).send({ changes: [{ key: 'imports:run', enabled: false }], version: d.body.version });
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      const r = await upload(hrToken, 'employees', [['Employee ID', 'Full name', 'Date of joining'], ['PUNE-04', 'Off Switch', '2023-03-01']]);
      expect(r.status).toBe(403);
      expect(await pool.count('audit_events', { tenant_id: t.id, action: 'hr_workspace.permissions_changed', resource_id: wsId })).toBe(1);
      const back = await api(app, owner).get(`/hr-workspaces/${wsId}`);
      expect((await api(app, owner).put(`/hr-workspaces/${wsId}/permissions`).send({ changes: [{ key: 'imports:run', enabled: true }], version: back.body.version })).status).toBe(200);
      expect((await upload(hrToken, 'employees', [['Employee ID', 'Full name', 'Date of joining'], ['PUNE-04', 'On Again', '2023-03-01']])).status).toBe(201);
    });
  });

  describe('the Employee Workspace', () => {
    it('cannot import or see imports, and does not see fields kept from it', async () => {
      expect((await api(app, staffToken).get('/imports')).status).toBe(403);
      expect((await upload(staffToken, 'employees', [['Employee ID'], ['X-1']])).status).toBe(403);
      const me = await pool.one('employees', { tenant_id: t.id, employee_code: 'EMP-STAFF' });
      const fields = await api(app, staffToken).get(`/custom-fields/values/employee/${me!.id}`);
      expect(fields.status, JSON.stringify(fields.body)).toBe(200);
      expect(JSON.stringify(fields.body)).not.toContain('shirt_size');
    });
  });

  describe('other records', () => {
    it('imports departments with parents from the same file', async () => {
      const r = await upload(owner, 'departments', [['Department', 'Code', 'Parent department'], ['Analytics', 'ANL', 'Data Science'], ['BI Reporting', 'BIR', 'Analytics']]);
      const v = await api(app, owner).put(`/imports/${r.body.id}/mapping`).send({ mapping: mapAll(r.body), options: { duplicates: 'skip', matchBy: ['name'], addMissingValues: true } });
      expect(v.body.summary, JSON.stringify(v.body)).toMatchObject({ valid: 2, errors: 0 });
      await api(app, owner).post(`/imports/${r.body.id}/run`);
      expect((await finish(owner, r.body.id)).summary.imported).toBe(2);
      const anl = await pool.one('departments', { tenant_id: t.id, name: 'Analytics' });
      const bi = await pool.one('departments', { tenant_id: t.id, name: 'BI Reporting' });
      expect(bi!.parent_id).toBe(anl!.id);
    });

    it('imports clients with their main contact, then more contacts linked by client name', async () => {
      const c = await upload(owner, 'clients', [['Client name', 'Industry', 'Contact person', 'Contact email'], ['Acme Foods', 'Food and beverage', 'Neha Shah', 'neha@acme.example'], ['Zenith Agro', 'Agritech', '', '']]);
      const cv = await api(app, owner).put(`/imports/${c.body.id}/mapping`).send({ mapping: mapAll(c.body), options: { duplicates: 'skip', matchBy: ['name'], addMissingValues: true } });
      expect(cv.body.summary, JSON.stringify(cv.body)).toMatchObject({ errors: 0 });
      await api(app, owner).post(`/imports/${c.body.id}/run`);
      expect((await finish(owner, c.body.id)).summary.imported).toBe(2);
      const acme = await pool.one('clients', { tenant_id: t.id, name: 'Acme Foods' });
      expect(acme).toMatchObject({ contact_email: 'neha@acme.example', source_import_id: c.body.id });
      const k = await upload(owner, 'contacts', [['Company', 'Name', 'Email', 'Title'], ['Acme Foods', 'Vik Rao', 'vik@acme.example', 'Procurement head'], ['Nobody Ltd', 'Lost Soul', 'lost@nobody.example', '']]);
      const kv = await api(app, owner).put(`/imports/${k.body.id}/mapping`).send({ mapping: mapAll(k.body), options: { duplicates: 'skip', matchBy: ['email'], addMissingValues: true } });
      expect(kv.body.summary, JSON.stringify(kv.body)).toMatchObject({ valid: 1, errors: 1 });
      await api(app, owner).post(`/imports/${k.body.id}/run`);
      await finish(owner, k.body.id);
      const contacts = await api(app, owner).get(`/staffing/clients/${acme!.id}/contacts`);
      expect(contacts.body.map((x: { name: string }) => x.name).sort()).toEqual(['Neha Shah', 'Vik Rao']);
    });

    it('imports candidates once the importer confirms they may hold their details', async () => {
      const r = await upload(owner, 'candidates', [['Candidate name', 'Email', 'Source', 'Skills'], ['Kiran Rao', 'kiran@cand.example', 'LinkedIn', 'React; Node.js']]);
      const refused = await api(app, owner).put(`/imports/${r.body.id}/mapping`).send({ mapping: mapAll(r.body), options: { duplicates: 'skip', matchBy: ['email'], addMissingValues: true } });
      expect(refused.status).toBe(422);
      const v = await api(app, owner).put(`/imports/${r.body.id}/mapping`).send({ mapping: mapAll(r.body), options: { duplicates: 'skip', matchBy: ['email'], addMissingValues: true, lawfulBasisConfirmed: true } });
      expect(v.body.summary, JSON.stringify(v.body)).toMatchObject({ errors: 0 });
      await api(app, owner).post(`/imports/${r.body.id}/run`);
      expect((await finish(owner, r.body.id)).summary.imported).toBe(1);
      expect(await pool.one('candidates', { tenant_id: t.id, email: 'kiran@cand.example' })).toMatchObject({ source: 'sourced', source_detail: 'LinkedIn', tags: ['React', 'Node.js'] });
    });

    it('imports values into another list', async () => {
      const r = await upload(owner, 'master_values', [['Value', 'Category'], ['Prompt engineer', 'Technology'], ['Agronomist', 'Operations']], '&list=job_role');
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const v = await api(app, owner).put(`/imports/${r.body.id}/mapping`).send({ mapping: mapAll(r.body), options: { duplicates: 'update', matchBy: ['label'], addMissingValues: true } });
      expect(v.body.summary).toMatchObject({ errors: 0 });
      await api(app, owner).post(`/imports/${r.body.id}/run`);
      expect((await finish(owner, r.body.id)).summary.imported).toBe(2);
      expect((await api(app, owner).get('/master-data/job_role?q=Agronomist')).body.items.map((x: { label: string }) => x.label)).toEqual(['Agronomist']);
    });
  });
});
