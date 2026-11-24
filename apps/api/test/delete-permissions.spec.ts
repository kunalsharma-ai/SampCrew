import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { CONSOLE_DELETE_ACTIONS, deleteActionFor, isNotDeleteAction, WORKSPACE_DELETE_ACTIONS } from '@crew/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTROLLERS } from '../src/app.module';
import { hashPassword } from '../src/platform/auth/crypto';
import { currentTotp } from '../src/platform/auth/mfa';
import { REALM_KEY } from '../src/platform/authz/decorators';
import { addMember, adminPool, allowDeletes, api, createApp, createTenant, department, login, loginWithMfa, PASSWORD, type TestDb, type TestTenant } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = Record<string, any>;
type Ctor = new (...args: never[]) => unknown;

/** Every route of the API: method, path below /api/v1 and realm. */
function routes() {
  const out: { method: string; path: string; realm: string; name: string }[] = [];
  for (const ctrl of CONTROLLERS as Ctor[]) {
    const base = (Reflect.getMetadata(PATH_METADATA, ctrl) as string) ?? '';
    const classRealm = (Reflect.getMetadata(REALM_KEY, ctrl) as { realm: string } | undefined)?.realm;
    for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
      const handler = (ctrl.prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function' || name === 'constructor') continue;
      const m = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (m === undefined) continue;
      const sub = (Reflect.getMetadata(PATH_METADATA, handler) as string) ?? '';
      const path = [base, sub].map((p) => p.replace(/^\/|\/$/g, '')).filter(Boolean).join('/').replace(/:[A-Za-z]+/g, 'x');
      out.push({ method: RequestMethod[m]!, path, realm: (Reflect.getMetadata(REALM_KEY, handler) as { realm: string } | undefined)?.realm ?? classRealm ?? 'workspace', name: `${ctrl.name}.${name}` });
    }
  }
  return out;
}

describe('every delete action is in the registry', () => {
  const all = routes();
  it('every DELETE route is a listed delete action, or listed as not deleting anything (with the reason)', () => {
    const unlisted = all.filter((r) => r.method === 'DELETE')
      .filter((r) => !deleteActionFor(r.realm === 'platform' ? CONSOLE_DELETE_ACTIONS : WORKSPACE_DELETE_ACTIONS, r.path, 'DELETE') && !isNotDeleteAction(r.path, 'DELETE'))
      .map((r) => `${r.name} DELETE /${r.path}`);
    expect(unlisted).toEqual([]);
  });
  it('archive and erase routes are delete actions too', () => {
    const unlisted = all.filter((r) => r.method !== 'DELETE' && r.method !== 'GET' && /\/(archive|erase)$/.test(r.path))
      .filter((r) => !(r.realm === 'platform' ? CONSOLE_DELETE_ACTIONS : WORKSPACE_DELETE_ACTIONS).some((a) => a.method === r.method && a.path.replace(/\*/g, 'x') === r.path))
      .map((r) => `${r.name} ${r.method} /${r.path}`);
    expect(unlisted).toEqual([]);
  });
  it('every listed action is a real route (nothing stale)', () => {
    const stale = [...WORKSPACE_DELETE_ACTIONS, ...CONSOLE_DELETE_ACTIONS]
      .filter((a) => !all.some((r) => r.method === a.method && r.path === a.path.replace(/\*/g, 'x')))
      .map((a) => `${a.method} /${a.path}`);
    expect(stale).toEqual([]);
  });
});

/**
 * Kunal's rules (2026-11-23): nobody deletes anything without typing their own password first, and only with the
 * permission of the level above: Console Admin > Super Workspace > HR Workspace / Employee Workspace.
 */
describe('password-confirmed, permission-gated deletion', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let sup: string;
  let hr: string;
  let emp: string;
  let consoleToken: string;
  let viewerConsole: string;
  const raw = (token: string) => api(app, token, { confirmDelete: false });
  const confirm = (token: string, password = PASSWORD) => api(app, token).post('/me/delete-confirmation').send({ password });
  const ok = (res: { status: number; body: unknown }, status = 200): Any => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Any;
  };
  const done = (res: { status: number; body: unknown }) => expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  const code = (res: { body: Any }) => res.body?.error?.code as string | undefined;
  const newView = async (token: string, name: string) => ok(await api(app, token).post('/me/views').send({ page: 'employees', name, state: {} }), 201).id as string;
  const lastAudit = (action: string) => pool.one('audit_events', { tenant_id: t.id, action }, { sort: { created_at: -1 } });

  async function consoleAdmin(role: string) {
    const email = `delete-${role}-${Date.now()}@sampledge.test`;
    await pool.insert('platform_admins', { email, full_name: `Delete ${role}`, password_hash: await hashPassword(PASSWORD), role });
    const res = await api(app).post('/platform/auth/login').send({ email, password: PASSWORD });
    const setup = await api(app, res.body.accessToken).post('/platform/auth/mfa/setup');
    return (await api(app, res.body.accessToken).post('/platform/auth/mfa/enable').send({ code: currentTotp(setup.body.secret) })).body.accessToken as string;
  }

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool, { plan: 'business', deletes: false });
    sup = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    hr = (await loginWithMfa(app, pool, (await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' })).email)).accessToken;
    emp = (await login(app, (await addMember(pool, t, { name: 'Esha Employee' })).email)).accessToken;
    consoleToken = await consoleAdmin('super_admin');
    viewerConsole = await consoleAdmin('support');
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('Super Workspace: a delete without the password is refused, a wrong password deletes nothing, the right one allows exactly one delete', async () => {
    const a = await department(pool, t, 'Delete A');
    const b = await department(pool, t, 'Delete B');
    const first = await raw(sup).delete(`/org/departments/${a}`);
    expect(first.status).toBe(403);
    expect(code(first)).toBe('delete_password_required');
    const wrong = await confirm(sup, 'not-my-password');
    expect(wrong.status).toBe(400);
    expect(code(wrong)).toBe('wrong_password');
    expect(code(await raw(sup).delete(`/org/departments/${a}`))).toBe('delete_password_required');
    ok(await confirm(sup));
    done(await raw(sup).delete(`/org/departments/${a}`));
    // One password, one delete: the next delete asks again.
    expect(code(await raw(sup).delete(`/org/departments/${b}`))).toBe('delete_password_required');
    const audit = await lastAudit('delete.performed');
    expect(audit?.resource_id).toBe(a);
    expect(audit?.metadata).toMatchObject({ area: 'organization', what: 'Department', reauthenticated: true });
    expect(await lastAudit('delete.password_failed')).toBeTruthy();
  });

  it('a confirmation older than two minutes no longer allows a delete', async () => {
    const a = await department(pool, t, 'Delete expired');
    ok(await confirm(sup));
    await pool.update('sessions', { tenant_id: t.id, delete_confirmed_until: { $ne: null } }, { $set: { delete_confirmed_until: new Date(Date.now() - 1000) } });
    expect(code(await raw(sup).delete(`/org/departments/${a}`))).toBe('delete_password_required');
  });

  it('HR Workspace has no delete option until the Super Workspace switches it on, and then still needs the password', async () => {
    const a = await department(pool, t, 'Delete by HR');
    expect((ok(await api(app, hr).get('/me')).deleteAreas as string[])).toEqual([]);
    const refused = await raw(hr).delete(`/org/departments/${a}`);
    expect(refused.status).toBe(403);
    expect(code(refused)).toBe('delete_not_permitted');
    expect(refused.body.error.message).toContain('Super Workspace');
    expect((await lastAudit('delete.denied'))?.metadata).toMatchObject({ area: 'organization', reason: 'not_permitted', level: 'hr' });

    // The Super Workspace switches "Delete: Company structure" on for company-wide HR in Settings > Workspace Permissions.
    const view = ok(await api(app, sup).get('/workspace-permissions?level=hr&groupId=central'));
    const cat = (view.categories as Any[]).find((c) => c.key === 'delete_permissions');
    expect(cat.items.find((i: Any) => i.key === 'delete.organization')).toMatchObject({ on: false, default: false, enforced: 'delete', blockedByConsole: false });
    ok(await api(app, sup).put('/workspace-permissions').send({ level: 'hr', groupId: 'central', permissions: { 'delete.organization': true } }));
    expect((ok(await api(app, hr).get('/me')).deleteAreas as string[])).toEqual(['organization']);
    expect(code(await raw(hr).delete(`/org/departments/${a}`))).toBe('delete_password_required');
    done(await api(app, hr).delete(`/org/departments/${a}`));
    // Another area stays closed.
    expect(code(await api(app, hr).delete('/leave/calendars/00000000-0000-4000-8000-000000000000'))).toBe('delete_not_permitted');
    // An HR Workspace can never give itself delete permissions.
    expect((await api(app, hr).put('/workspace-permissions').send({ level: 'hr', groupId: 'central', permissions: { 'delete.leave': true } })).status).toBe(403);
  });

  it('Employee Workspace has no delete option until the Super Workspace allows it', async () => {
    const v = await newView(emp, 'My view');
    expect(code(await raw(emp).delete(`/me/views/${v}`))).toBe('delete_not_permitted');
    ok(await api(app, sup).put('/workspace-permissions').send({ level: 'employee', groupId: 'all', permissions: { 'delete.personal': true } }));
    expect(code(await raw(emp).delete(`/me/views/${v}`))).toBe('delete_password_required');
    expect((await api(app, emp).delete(`/me/views/${v}`)).status).toBeLessThan(300);
    // Employee Workspace cannot be given areas it has no use for (company structure is HR only).
    expect((await api(app, sup).put('/workspace-permissions').send({ level: 'employee', groupId: 'all', permissions: { 'delete.organization': true } })).status).toBe(400);
  });

  it('Console Admin decides what the Super Workspace may delete; an area off there is off for every level of the company', async () => {
    const view = ok(await api(app, consoleToken).get(`/platform/tenants/${t.id}/access/delete-rights`));
    expect((view.areas as Any[]).every((a) => a.allowed)).toBe(true);
    // A Console role without Manage access cannot change it.
    expect((await api(app, viewerConsole).put(`/platform/tenants/${t.id}/access/delete-rights`).send({ areasOff: ['organization'] })).status).toBe(403);
    const after = ok(await api(app, consoleToken).put(`/platform/tenants/${t.id}/access/delete-rights`).send({ areasOff: ['organization'], reason: 'Structure is managed by SAMPLEDGE' }));
    expect((after.areas as Any[]).find((a) => a.key === 'organization').allowed).toBe(false);

    const a = await department(pool, t, 'Delete blocked by Console');
    const s = await api(app, sup).delete(`/org/departments/${a}`);
    expect(code(s)).toBe('delete_not_permitted');
    expect(s.body.error.message).toContain('Console Admin');
    // HR keeps its saved switch, but it has no effect while the Console has the area off.
    expect(code(await api(app, hr).delete(`/org/departments/${a}`))).toBe('delete_not_permitted');
    expect((ok(await api(app, sup).get('/me')).deleteAreas as string[])).not.toContain('organization');
    const wp = ok(await api(app, sup).get('/workspace-permissions?level=hr&groupId=central'));
    expect((wp.categories as Any[]).find((c) => c.key === 'delete_permissions').items.find((i: Any) => i.key === 'delete.organization').blockedByConsole).toBe(true);
    expect(await pool.one('audit_events', { tenant_id: t.id, action: 'access.delete_rights_changed' })).toBeTruthy();

    ok(await api(app, consoleToken).put(`/platform/tenants/${t.id}/access/delete-rights`).send({ areasOff: [] }));
    done(await api(app, sup).delete(`/org/departments/${a}`));
  });

  it('Console Admins delete only with "Delete records" in their role, and always with their password', async () => {
    const make = async (key: string) => ok(await api(app, consoleToken).post('/platform/help/manage/categories').send({ key, name: `Delete ${key}`, audiences: ['employee'] }), 201).id as string;
    const c1 = await make(`del-a-${Date.now()}`);
    const first = await api(app, consoleToken, { confirmDelete: false }).delete(`/platform/help/manage/categories/${c1}`);
    expect(code(first)).toBe('delete_password_required');
    const wrong = await api(app, consoleToken).post('/platform/auth/delete-confirmation').send({ password: 'nope-nope' });
    expect(code(wrong)).toBe('wrong_password');
    ok(await api(app, consoleToken).post('/platform/auth/delete-confirmation').send({ password: PASSWORD }));
    expect((await api(app, consoleToken, { confirmDelete: false }).delete(`/platform/help/manage/categories/${c1}`)).status).toBeLessThan(300);
    expect(await pool.one('audit_events', { tenant_id: null, action: 'delete.performed', resource_id: c1 })).toBeTruthy();

    // A role with Help content but without Delete records.
    const role = ok(await api(app, consoleToken).post('/platform/roles').send({ name: `Help writer ${Date.now() % 100000}`, permissions: ['help:manage'] }), 201);
    const writer = await consoleAdmin(role.key);
    const c2 = await make(`del-b-${Date.now()}`);
    const refused = await api(app, writer).delete(`/platform/help/manage/categories/${c2}`);
    expect(code(refused)).toBe('delete_not_permitted');
  });
});
