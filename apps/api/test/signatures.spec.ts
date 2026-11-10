import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { imageSize } from '../src/modules/signatures/signatures.service';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

// A real 1x1 PNG, and a 3x1 PNG for the logo's proportions.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const WIDE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAABCAYAAAAb4BS0AAAAEElEQVR42mNk+M9QzwABAAMZAQUNdDmYAAAAAElFTkSuQmCC', 'base64');
const today = () => new Date().toISOString().slice(0, 10);

/** Outlook email signatures: designs, company settings, and the Windows sync that installs them. */
describe('email signatures', () => {
  let app: INestApplication;
  let pool: TestDb;
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
      // Windows details that only show on a real PC: the path reaches PowerShell through a variable (an apostrophe in
      // a folder name cannot break it), the task is a definition that runs on battery and catches up after sleep, it
      // starts with no window, and no native error output is redirected while errors stop the script.
      expect(file).toContain('set "SAMPCREW_SETUP=%~f0"');
      expect(file).toContain('ReadAllText($env:SAMPCREW_SETUP)');
      expect(file).toContain('/XML $TaskXmlPath');
      expect(file).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
      expect(file).toContain('<StartWhenAvailable>true</StartWhenAvailable>');
      expect(file).toContain('<Command>wscript.exe</Command>');
      expect(file).toContain("if ($Trigger -eq 'uninstall')");
      expect(file).not.toMatch(/schtasks\.exe [^\r\n]*2>\$null/);
      token = tokenOf(file);
      agentId = r.body.id;
      // Only a hash is stored.
      const row = (await pool.one('signature_agents', { id: agentId }))!;
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
      await pool.update('employees', { id: empId }, { $set: { photo_content_type: 'image/webp' } });
      const r = await agent(token).sync({});
      expect(r.body.html).not.toContain('photo.');
      expect(r.body.images.map((i: { name: string }) => i.name)).toEqual(['logo.png']);
      expect((await agent(token).image('photo')).status).toBe(404);
      expect((await api(app, meToken).get('/signatures/me')).body.photoNotForOutlook).toBe(true);
      await pool.update('employees', { id: empId }, { $set: { photo_content_type: 'image/png' } });
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

  describe('festival, celebration and company banners', () => {
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    // A real 4x2 GIF (GIF89a header with logical screen 4x2).
    const GIF = Buffer.from('R0lGODlhBAACAIAAAP///wAAACH5BAEAAAAALAAAAAAEAAIAAAIChF8AOw==', 'base64');
    let token: string;
    let bannerId: string;

    it('reads GIF sizes and lets only admins manage banners', async () => {
      expect(imageSize(GIF, 'image/gif')).toEqual({ width: 4, height: 2 });
      const body = { title: 'Product launch', message: 'Our new range is here!', icon: '🚀', bgColor: '#7E22CE', startsOn: day(-1), endsOn: day(1), linkUrl: 'https://acme.example/new' };
      expect([403, 404]).toContain((await api(app, meToken).post('/signatures/banners').send(body)).status);
      expect((await api(app, owner).post('/signatures/banners').send({ title: 'x', message: 'y' })).status).toBe(422);
      const r = await api(app, owner).post('/signatures/banners').send(body);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body).toMatchObject({ title: 'Product launch', startsOn: day(-1), endsOn: day(1), position: 'below', enabled: true, image: null });
      bannerId = r.body.id;
      // A festival from the library follows its own dates; the same festival cannot be added twice.
      const diwali = await api(app, owner).post('/signatures/banners').send({ occasionKey: 'diwali', title: 'Diwali', message: 'Happy Diwali from Acme!', icon: '🪔' });
      expect(diwali.status, JSON.stringify(diwali.body)).toBe(201);
      expect((await api(app, owner).post('/signatures/banners').send({ occasionKey: 'diwali', title: 'Diwali', message: 'Again' })).status).toBe(409);
      expect((await api(app, owner).get('/signatures/banners')).body).toHaveLength(2);
    });

    it('puts today\'s company banner in the signature, with its image, and updates the computer when it changes', async () => {
      token = tokenOf((await api(app, meToken).post('/signatures/me/agents').send({ name: 'Banner PC' })).body.installer);
      const mine = (await api(app, meToken).get('/signatures/me')).body;
      expect(mine.banners.map((b: { title: string }) => b.title)).toContain('Product launch');
      expect(mine.data.banner).toMatchObject({ message: 'Our new range is here!', icon: '🚀', bgColor: '#7E22CE' });
      let r = await agent(token).sync({ trigger: 'install' });
      expect(r.body.html).toContain('Our new range is here!');
      expect(r.body.html).toContain('href="https://acme.example/new"');
      expect(r.body.text).toContain('🚀 Our new range is here!');
      await agent(token).report({ version: r.body.version, ok: true });
      // An animated GIF banner: the computer downloads it next to the signature.
      expect((await api(app, owner).put(`/signatures/banners/${bannerId}/image`).attach('file', Buffer.from('GIF89a nope'), { filename: 'x.gif', contentType: 'image/webp' })).status).toBe(400);
      const img = await api(app, owner).put(`/signatures/banners/${bannerId}/image`).attach('file', GIF, { filename: 'launch.gif', contentType: 'image/gif' });
      expect(img.status, JSON.stringify(img.body)).toBe(200);
      expect(img.body.image).toMatchObject({ width: 4, height: 2, contentType: 'image/gif' });
      const prev = r.body.version;
      r = await agent(token).sync({ currentVersion: prev, trigger: 'scheduled' });
      expect(r.body.status).toBe('update');
      const name = `banner-${bannerId.slice(0, 8)}.gif`;
      expect(r.body.html).toContain(`src="SampCrew_files/${name}" width="4" height="2"`);
      expect(r.body.images).toContainEqual({ name, path: '/signature-agent/images/banner' });
      const file = await agent(token).image('banner');
      expect(file.status).toBe(200);
      expect(file.headers['content-type']).toBe('image/gif');
      expect((await api(app, meToken).get(`/signatures/banners/${bannerId}/image`)).status).toBe(200);
      await agent(token).report({ version: r.body.version, ok: true });
    });

    it('lets each person turn company banners off and use their own festivals and message', async () => {
      const current = (await api(app, meToken).get('/signatures/me')).body;
      const save = (wishes: Record<string, unknown>) => api(app, meToken).put('/signatures/me').send({ template: current.template, options: { ...current.options, wishes }, syncMode: current.ownSyncMode });
      let r = await save({ showCompany: false, message: 'On leave until Monday', icon: '🌴', from: day(-1), to: day(2) });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.data.banner).toMatchObject({ message: 'On leave until Monday', icon: '🌴' });
      const sync = await agent(token).sync({ trigger: 'scheduled' });
      expect(sync.body.html).toContain('On leave until Monday');
      expect(sync.body.html).not.toContain('Our new range');
      expect(sync.body.images.some((i: { name: string }) => i.name.startsWith('banner-'))).toBe(false);
      expect((await agent(token).image('banner')).status).toBe(404);
      expect((await save({ occasions: ['not-real'] })).status).toBe(422);
      // Disabling the company banner and clearing the message leaves no banner.
      r = await save({ showCompany: true });
      expect(r.body.data.banner.message).toBe('Our new range is here!');
      const b = (await api(app, owner).get('/signatures/banners')).body.find((x: { id: string }) => x.id === bannerId);
      expect((await api(app, owner).put(`/signatures/banners/${bannerId}`).send({ ...b, image: undefined, id: undefined, createdAt: undefined, updatedAt: undefined, enabled: false })).status).toBe(200);
      expect((await api(app, meToken).get('/signatures/me')).body.data.banner?.message ?? null).not.toBe('Our new range is here!');
      expect((await api(app, owner).delete(`/signatures/banners/${bannerId}`)).status).toBe(204);
      expect((await api(app, owner).get('/signatures/banners')).body.some((x: { id: string }) => x.id === bannerId)).toBe(false);
    });
  });
});
