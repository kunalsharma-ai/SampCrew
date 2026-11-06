import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { imageSize } from '../src/modules/signatures/signatures.service';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, type TestTenant } from './helpers';

// A real 1x1 PNG, and a 3x1 PNG for the logo's proportions.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const WIDE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAABCAYAAAAb4BS0AAAAEElEQVR42mNk+M9QzwABAAMZAQUNdDmYAAAAAElFTkSuQmCC', 'base64');
const today = () => new Date().toISOString().slice(0, 10);

/** Outlook email signatures: designs, company settings, and the Windows sync that installs them. */
describe('email signatures', () => {
  let app: INestApplication;
  let pool: Pool;
  let t: TestTenant;
  let owner: string;
  let me: { email: string; membershipId: string };
  let meToken: string;
  let empId: string;
  const http = () => request(app.getHttpServer());
  const agent = (token: string) => ({
    sync: (body: Record<string, unknown> = {}) => http().post('/api/v1/signature-agent/sync').set('authorization', `Bearer ${token}`).send(body),
    report: (body: Record<string, unknown>) => http().post('/api/v1/signature-agent/report').set('authorization', `Bearer ${token}`).send(body),
    image: (kind: string) => http().get(`/api/v1/signature-agent/images/${kind}`).set('authorization', `Bearer ${token}`),
  });
  const tokenOf = (installer: string) => /\$Token = '(scsig_[A-Za-z0-9_-]+)'/.exec(installer)![1]!;

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    me = await addMember(pool, t, { name: 'Meera Joshi' });
    meToken = (await login(app, me.email)).accessToken;
    const des = (await api(app, owner).post('/designations').send({ name: 'Quality Lead' })).body.id;
    empId = (await api(app, owner).post('/employees').send({
      firstName: 'Meera', lastName: 'Joshi', workEmail: me.email, phone: '+91 98200 11111', legalEntityId: t.legalEntityId, designationId: des, dateOfJoining: today(), membershipId: me.membershipId,
    })).body.employee.id;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('reads PNG and JPEG sizes', () => {
    expect(imageSize(WIDE, 'image/png')).toEqual({ width: 3, height: 1 });
    // SOI, APP0 (len 16), SOF0 with height 40 and width 120.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x28, 0x00, 0x78, 0x03]);
    expect(imageSize(jpeg, 'image/jpeg')).toEqual({ width: 120, height: 40 });
  });

  it('starts everyone on the company default, filled from their record', async () => {
    const r = await api(app, meToken).get('/signatures/me');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ employeeId: empId, saved: false, template: 'classic', syncMode: 'auto', agents: [] });
    expect(r.body.data).toMatchObject({ fullName: 'Meera Joshi', jobTitle: 'Quality Lead', email: me.email, mobile: '+91 98200 11111' });
    // A login with no employee record is told why.
    expect((await api(app, owner).get('/signatures/me')).body.error.code).toBe('no_employee_record');
  });

  it('lets admins set the company details, and only admins', async () => {
    const body = { companyName: 'Acme Tools', website: 'https://acme.example', phone: '+91 20 5555 0100', brandColor: '#0B5394', accentColor: '#F1C232', defaultTemplate: 'banner', disclaimer: 'Confidential.', social: { linkedin: 'https://linkedin.com/company/acme' } };
    expect([403, 404]).toContain((await api(app, meToken).put('/signatures/settings').send(body)).status);
    const r = await api(app, owner).put('/signatures/settings').send(body);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ companyName: 'Acme Tools', defaultTemplate: 'banner', syncMode: 'auto' });
    expect((await api(app, owner).put('/signatures/settings').send({ brandColor: 'blue' })).status).toBe(422);
    // The logo keeps its proportions; WebP and fake images are refused.
    const logo = await api(app, owner).put('/signatures/settings/logo').attach('file', WIDE, { filename: 'logo.png', contentType: 'image/png' });
    expect(logo.status, JSON.stringify(logo.body)).toBe(200);
    expect(logo.body.logo).toMatchObject({ width: 3, height: 1 });
    expect((await api(app, owner).put('/signatures/settings/logo').attach('file', Buffer.from('not an image'), { filename: 'x.png', contentType: 'image/png' })).status).toBe(400);
    expect((await api(app, meToken).get('/signatures/logo')).status).toBe(200);
    const mine = (await api(app, meToken).get('/signatures/me')).body;
    expect(mine).toMatchObject({ template: 'banner', data: { company: 'Acme Tools', website: 'https://acme.example', phone: '+91 20 5555 0100', brandColor: '#0B5394', disclaimer: 'Confidential.' } });
    expect(mine.images.logo).not.toBeNull();
  });

  it('saves each person\'s design and changes', async () => {
    const r = await api(app, meToken).put('/signatures/me').send({
      template: 'photo-left', syncMode: 'manual',
      options: { accentColor: '#CC0000', font: 'Calibri', jobTitle: 'Head of Quality', pronouns: 'she/her', show: { address: true, department: false }, social: { x: 'https://x.com/meera' } },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ saved: true, template: 'photo-left', syncMode: 'manual', ownSyncMode: 'manual' });
    expect(r.body.data).toMatchObject({ jobTitle: 'Head of Quality', pronouns: 'she/her', accentColor: '#CC0000', brandColor: '#0B5394', font: 'Calibri' });
    // Company social links stay; their own are added.
    expect(r.body.data.social).toEqual({ linkedin: 'https://linkedin.com/company/acme', x: 'https://x.com/meera' });
    expect((await api(app, meToken).put('/signatures/me').send({ template: 'nope', options: {} })).status).toBe(422);
    expect((await api(app, meToken).put('/signatures/me').send({ template: 'classic', options: { ctaUrl: 'javascript:alert(1)' } })).status).toBe(422);
  });

  it('respects a company that fixes the design or the sync mode', async () => {
    const base = { companyName: 'Acme Tools', defaultTemplate: 'banner', syncMode: 'auto' };
    await api(app, owner).put('/signatures/settings').send({ ...base, lockTemplate: true, allowEmployeeSyncChoice: false });
    const locked = (await api(app, meToken).get('/signatures/me')).body;
    expect(locked).toMatchObject({ template: 'banner', syncMode: 'auto' });
    expect((await api(app, meToken).put('/signatures/me').send({ template: 'classic', options: {} })).body.error.code).toBe('template_locked');
    expect((await api(app, meToken).put('/signatures/me').send({ template: 'banner', syncMode: 'manual', options: {} })).body.error.code).toBe('sync_mode_locked');
    await api(app, owner).put('/signatures/settings').send({ companyName: 'Acme Tools', website: 'https://acme.example', defaultTemplate: 'banner', syncMode: 'auto', social: { linkedin: 'https://linkedin.com/company/acme' } });
    await api(app, meToken).put('/signatures/me').send({ template: 'photo-left', syncMode: 'manual', options: { jobTitle: 'Head of Quality' } });
  });

  describe('Windows sync', () => {
    let token: string;
    let agentId: string;

    it('gives each computer a setup file with its own token, once', async () => {
      const r = await api(app, meToken).post('/signatures/me/agents').send({ name: 'Office laptop' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.fileName).toBe('SampCrew-Outlook-Signature-Setup.cmd');
      const file = r.body.installer as string;
      expect(file.startsWith('@echo off\r\n')).toBe(true);
      expect(file).not.toMatch(/[^\r]\n/);
      expect(file).toContain("$Api = 'http");
      expect(file).toContain('Microsoft\\Signatures');
      expect(file).toContain('Office\\$v\\Common\\MailSettings');
      token = tokenOf(file);
      agentId = r.body.id;
      // Only a hash is stored.
      const row = (await pool.query('select token_hash, token_hint from signature_agents where id = $1', [agentId])).rows[0];
      expect(row.token_hash).not.toContain(token);
      expect(token.endsWith(row.token_hint)).toBe(true);
      expect((await api(app, meToken).get('/signatures/me')).body.agents).toEqual([expect.objectContaining({ id: agentId, name: 'Office laptop', lastAppliedAt: null })]);
    });

    it('sends the signature with images, then nothing until it changes', async () => {
      await api(app, meToken).put(`/employees/${empId}/photo`).attach('file', PNG, { filename: 'me.png', contentType: 'image/png' });
      const first = await agent(token).sync({ trigger: 'install', computerName: 'LAPTOP-7', outlookVersions: ['15.0'], agentVersion: '1.0.0' });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body).toMatchObject({ status: 'update', mode: 'manual', name: 'SampCrew' });
      expect(first.body.html).toContain('Meera Joshi');
      expect(first.body.html).toContain('Head of Quality');
      expect(first.body.html).toContain('src="SampCrew_files/photo.png"');
      expect(first.body.html).toContain('src="SampCrew_files/logo.png"');
      expect(first.body.text).toContain('Meera Joshi');
      expect(first.body.images).toEqual([{ name: 'photo.png', path: '/signature-agent/images/photo' }, { name: 'logo.png', path: '/signature-agent/images/logo' }]);
      for (const kind of ['photo', 'logo']) {
        const img = await agent(token).image(kind);
        expect(img.status).toBe(200);
        expect(img.headers['content-type']).toBe('image/png');
      }
      expect((await agent(token).report({ version: first.body.version, ok: true, outlookVersions: ['15.0'] })).status).toBe(200);
      const mine = (await api(app, meToken).get('/signatures/me')).body;
      expect(mine.agents[0]).toMatchObject({ computerName: 'LAPTOP-7', outlookVersions: ['15.0'], lastTrigger: 'install', upToDate: true, lastError: null });

      const again = await agent(token).sync({ currentVersion: first.body.version, trigger: 'scheduled' });
      expect(again.body).toEqual({ status: 'unchanged', version: first.body.version, mode: 'manual' });

      // A change in SampCrew (here a new designation from HR... or their own edit) makes a new version.
      await api(app, meToken).put('/signatures/me').send({ template: 'banner', syncMode: 'auto', options: { jobTitle: 'Head of Quality' } });
      const changed = await agent(token).sync({ currentVersion: first.body.version });
      expect(changed.body).toMatchObject({ status: 'update', mode: 'auto' });
      expect(changed.body.version).not.toBe(first.body.version);
      expect((await api(app, meToken).get('/signatures/me')).body.agents[0].upToDate).toBe(false);
      await agent(token).report({ version: changed.body.version, ok: true });

      // "Sync now" in SampCrew sends it again even when nothing changed, once.
      await api(app, meToken).post('/signatures/me/sync-request');
      expect((await agent(token).sync({ currentVersion: changed.body.version })).body.status).toBe('update');
      await agent(token).report({ version: changed.body.version, ok: true });
      expect((await agent(token).sync({ currentVersion: changed.body.version })).body.status).toBe('unchanged');

      // Failures are shown to the person and the admin.
      await agent(token).report({ version: changed.body.version, ok: false, error: 'Access to the path is denied.' });
      expect((await api(app, meToken).get('/signatures/me')).body.agents[0].lastError).toBe('Access to the path is denied.');
      const overview = (await api(app, owner).get('/signatures/overview')).body;
      expect(overview.people.find((p: { id: string }) => p.id === empId)).toMatchObject({ template: 'banner', computers: 1, lastError: 'Access to the path is denied.' });
      expect([403, 404]).toContain((await api(app, meToken).get('/signatures/overview')).status);
    });

    it('leaves out a WebP photo, which Outlook 2013 cannot show', async () => {
      await pool.query(`update employees set photo_content_type = 'image/webp' where id = $1`, [empId]);
      const r = await agent(token).sync({});
      expect(r.body.html).not.toContain('photo.');
      expect(r.body.images.map((i: { name: string }) => i.name)).toEqual(['logo.png']);
      expect((await agent(token).image('photo')).status).toBe(404);
      expect((await api(app, meToken).get('/signatures/me')).body.photoNotForOutlook).toBe(true);
      await pool.query(`update employees set photo_content_type = 'image/png' where id = $1`, [empId]);
    });

    it('refuses unknown, disconnected and other people\'s computers', async () => {
      expect((await agent('scsig_nope').sync({})).status).toBe(401);
      expect((await http().post('/api/v1/signature-agent/sync').send({})).status).toBe(401);
      // Someone else cannot disconnect it; its owner can.
      const other = await addMember(pool, t, { name: 'Other Person' });
      const otherToken = (await login(app, other.email)).accessToken;
      await api(app, owner).post('/employees').send({ firstName: 'Other', lastName: 'Person', legalEntityId: t.legalEntityId, dateOfJoining: today(), membershipId: other.membershipId });
      expect((await api(app, otherToken).delete(`/signatures/me/agents/${agentId}`)).status).toBe(404);
      expect((await api(app, meToken).delete(`/signatures/me/agents/${agentId}`)).status).toBe(204);
      expect((await agent(token).sync({})).status).toBe(401);
      expect((await agent(token).image('logo')).status).toBe(401);
      // An admin can disconnect anyone's computer.
      const second = tokenOf((await api(app, meToken).post('/signatures/me/agents').send({ name: 'Home PC' })).body.installer);
      const id2 = (await api(app, meToken).get('/signatures/me')).body.agents[0].id;
      expect((await api(app, owner).delete(`/signatures/agents/${id2}`)).status).toBe(204);
      expect((await agent(second).sync({})).status).toBe(401);
    });

    it('keeps workspaces apart', async () => {
      const t2 = await createTenant(pool);
      const owner2 = (await loginWithMfa(app, pool, t2.ownerEmail)).accessToken;
      expect((await api(app, owner2).get('/signatures/settings')).body.companyName).toBeNull();
      expect((await api(app, owner2).get('/signatures/overview')).body.people.some((p: { id: string }) => p.id === empId)).toBe(false);
      expect((await api(app, owner2).delete(`/signatures/agents/${agentId}`)).status).toBe(404);
    });
  });
});
