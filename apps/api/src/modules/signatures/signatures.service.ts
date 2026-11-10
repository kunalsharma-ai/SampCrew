import { Inject, Injectable } from '@nestjs/common';
import {
  type CompanyBanner, composeSignatureData, pickBanner, renderSignature, type SignatureBannerInput, todayIn, type SaveSignatureInput, type SignatureBase, type SignatureOptions, signatureOptionsInput, type SignatureSettingsInput,
  type SignatureSyncMode, SIGNATURE_TEMPLATE_KEYS, type SignatureTemplateKey, type signatureAgentReport, type signatureAgentSyncInput,
} from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { randomToken, sha256 } from '../../platform/auth/crypto';
import { AuthzService } from '../../platform/authz/authz.service';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx as Tx } from '../../platform/database/mongo.service';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
import { displayName } from '../employees/employee-view';
import { loadEntitlements } from '../../platform/entitlements/entitlements.service';
import { Errors } from '../../platform/http/errors';
import { sniffMatches, StorageService } from '../../platform/storage/storage.service';
import { buildInstaller, SIGNATURE_NAME } from './installer';

export const AGENT_TOKEN_PREFIX = 'scsig_';
export const LOGO_TYPES = ['image/png', 'image/jpeg'] as const;
export const LOGO_MAX_BYTES = 1024 * 1024;
export const BANNER_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif'] as const;
export const MAX_BANNERS = 100;
const BANNER_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' };
/** Outlook 2013 cannot show WebP, so only these photo types go into the signature. */
const OUTLOOK_IMAGE_TYPES = ['image/png', 'image/jpeg'];

interface SettingsRow {
  company_name: string | null; website: string | null; phone: string | null; address: string | null; brand_color: string; accent_color: string;
  default_template: string; disclaimer: string | null; social: Record<string, string>; sync_mode: SignatureSyncMode; allow_employee_sync_choice: boolean;
  lock_template: boolean; logo_key: string | null; logo_content_type: string | null; logo_width: number | null; logo_height: number | null; logo_updated_at: Date | null;
  updated_at: Date | null;
}
interface PersonRow {
  id: string; display_name: string; work_email: string | null; phone: string | null; designation: string | null; department: string | null;
  photo_key: string | null; photo_content_type: string | null; photo_updated_at: Date | null; tenant_name: string; tenant_website: string | null;
  tenant_phone: string | null; entity_address: string | null; entity_legal_name: string | null; timezone: string | null;
}
interface BannerRow {
  id: string; occasion_key: string | null; title: string; message: string; icon: string | null; bg_color: string; fg_color: string; link_url: string | null;
  starts_on: string | null; ends_on: string | null; position: 'above' | 'below'; enabled: boolean; image_key: string | null; image_content_type: string | null;
  image_width: number | null; image_height: number | null; image_updated_at: Date | null; created_at: Date; updated_at: Date;
}
const n = <T>(v: T | undefined): T | null => v ?? null;
const bannerRow = (d: Doc): BannerRow => ({
  id: d.id as string, occasion_key: n(d.occasion_key as string), title: d.title as string, message: d.message as string, icon: n(d.icon as string),
  bg_color: d.bg_color as string, fg_color: d.fg_color as string, link_url: n(d.link_url as string), starts_on: n(d.starts_on as string), ends_on: n(d.ends_on as string),
  position: d.position as BannerRow['position'], enabled: d.enabled as boolean, image_key: n(d.image_key as string), image_content_type: n(d.image_content_type as string),
  image_width: n(d.image_width as number), image_height: n(d.image_height as number), image_updated_at: n(d.image_updated_at as Date),
  created_at: d.created_at as Date, updated_at: d.updated_at as Date,
});
const bannerView = (b: BannerRow): CompanyBanner & { createdAt: Date; updatedAt: Date } => ({
  id: b.id, occasionKey: b.occasion_key, title: b.title, message: b.message, icon: b.icon, bgColor: b.bg_color, fgColor: b.fg_color, linkUrl: b.link_url,
  startsOn: b.starts_on, endsOn: b.ends_on, position: b.position, enabled: b.enabled,
  image: b.image_key && b.image_content_type && b.image_updated_at ? { updatedAt: b.image_updated_at.toISOString(), width: b.image_width ?? 480, height: b.image_height ?? 120, contentType: b.image_content_type } : null,
  createdAt: b.created_at, updatedAt: b.updated_at,
});
interface SignatureRow { template: string; options: unknown; sync_mode: SignatureSyncMode | null; sync_requested_at: Date | null; updated_at: Date }
interface AgentRow { id: string; tenant_id: string; employee_id: string; name: string; revoked_at: Date | null }

const DEFAULT_SETTINGS: SettingsRow = {
  company_name: null, website: null, phone: null, address: null, brand_color: '#1F3A93', accent_color: '#E8833A', default_template: 'classic', disclaimer: null,
  social: {}, sync_mode: 'auto', allow_employee_sync_choice: true, lock_template: false, logo_key: null, logo_content_type: null, logo_width: null, logo_height: null,
  logo_updated_at: null, updated_at: null,
};

const agentView = (a: Doc) => ({
  id: a.id as string, name: a.name as string, tokenHint: a.token_hint as string, computerName: n(a.computer_name as string), outlookVersions: (a.outlook_versions as string[]) ?? [],
  agentVersion: n(a.agent_version as string), createdAt: a.created_at as Date, lastSeenAt: n(a.last_seen_at as Date), lastTrigger: n(a.last_trigger as string),
  lastAppliedVersion: n(a.last_applied_version as string), lastAppliedAt: n(a.last_applied_at as Date), lastError: n(a.last_error as string), revokedAt: n(a.revoked_at as Date),
});
const agentRow = (a: Doc): AgentRow => ({ id: a.id as string, tenant_id: a.tenant_id as string, employee_id: a.employee_id as string, name: a.name as string, revoked_at: n(a.revoked_at as Date) });

const isTemplate = (k: string): k is SignatureTemplateKey => (SIGNATURE_TEMPLATE_KEYS as readonly string[]).includes(k);

/** Width and height of a PNG, JPEG or GIF, read from its header, so Outlook gets the image's real proportions. */
export function imageSize(buf: Buffer, type: string): { width: number; height: number } | null {
  if (type === 'image/gif' && buf.length >= 10 && buf.toString('ascii', 0, 4) === 'GIF8') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (type === 'image/png' && buf.length >= 24 && buf.toString('ascii', 12, 16) === 'IHDR') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (type === 'image/jpeg') {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1]!;
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

@Injectable()
export class SignaturesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------------------------------------------------
  // Company settings (org:manage)
  // ---------------------------------------------------------------------------------------------------------

  private async settingsRow(tx: Tx): Promise<SettingsRow> {
    const d = await tx.collection('signature_settings').findOne({});
    if (!d) return DEFAULT_SETTINGS;
    return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, d[k] ?? (DEFAULT_SETTINGS as unknown as Doc)[k] ?? null])) as unknown as SettingsRow;
  }

  private settingsView(s: SettingsRow) {
    return {
      companyName: s.company_name, website: s.website, phone: s.phone, address: s.address, brandColor: s.brand_color, accentColor: s.accent_color,
      defaultTemplate: s.default_template, disclaimer: s.disclaimer, social: s.social ?? {}, syncMode: s.sync_mode, allowEmployeeSyncChoice: s.allow_employee_sync_choice,
      lockTemplate: s.lock_template, logo: s.logo_key ? { updatedAt: s.logo_updated_at, width: s.logo_width, height: s.logo_height } : null, updatedAt: s.updated_at,
    };
  }

  async settings() {
    return this.db.tenant(async (tx) => this.settingsView(await this.settingsRow(tx)));
  }

  async saveSettings(input: SignatureSettingsInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const values = {
        company_name: input.companyName ?? null, website: input.website ?? null, phone: input.phone ?? null, address: input.address ?? null, brand_color: input.brandColor,
        accent_color: input.accentColor, default_template: input.defaultTemplate, disclaimer: input.disclaimer ?? null, social: input.social ?? {}, sync_mode: input.syncMode,
        allow_employee_sync_choice: input.allowEmployeeSyncChoice, lock_template: input.lockTemplate, updated_by: actor.membershipId,
      };
      await tx.collection('signature_settings').upsert({}, values, { $set: { ...values, updated_at: new Date() } });
      await this.audit.record(tx, { action: 'signature.settings_updated', resourceType: 'signature_settings', changes: { ...input } });
      return this.settingsView(await this.settingsRow(tx));
    });
  }

  async setLogo(file: { mimetype: string; size: number; buffer: Buffer } | undefined) {
    if (!file) throw Errors.badRequest('file_required', 'Choose a logo');
    if (!(LOGO_TYPES as readonly string[]).includes(file.mimetype)) throw Errors.badRequest('unsupported_type', 'Use a PNG or JPEG logo: Outlook 2013 cannot show other types');
    if (file.size <= 0 || file.size > LOGO_MAX_BYTES) throw Errors.badRequest('file_too_large', 'Logos can be up to 1 MB');
    if (!sniffMatches(file.mimetype, file.buffer.subarray(0, 512))) throw Errors.badRequest('content_mismatch', 'The file is not the image type it claims to be');
    const size = imageSize(file.buffer, file.mimetype);
    if (!size || size.width < 1 || size.height < 1 || size.width > 10000 || size.height > 10000) throw Errors.badRequest('unreadable_image', 'The logo image could not be read');
    const actor = requestContext.tenantActor();
    const key = this.storage.newKey(actor.tenantId);
    await this.storage.put(key, file.buffer, { upload: true });
    const old = await this.db.tenant(async (tx) => {
      const settings = tx.collection('signature_settings');
      await settings.upsert({}, {});
      await settings.lock({});
      const prev = ((await settings.findOne({}))!.logo_key as string | null) ?? null;
      const now = new Date();
      await settings.update({}, { $set: { logo_key: key, logo_content_type: file.mimetype, logo_width: size.width, logo_height: size.height, logo_updated_at: now, updated_by: actor.membershipId, updated_at: now } });
      await this.audit.record(tx, { action: 'signature.logo_updated', resourceType: 'signature_settings', metadata: { contentType: file.mimetype, ...size } });
      return prev;
    });
    if (old) await this.storage.remove(old).catch(() => undefined);
    return this.settings();
  }

  async removeLogo() {
    const old = await this.db.tenant(async (tx) => {
      const settings = tx.collection('signature_settings');
      await settings.lock({});
      const prev = ((await settings.findOne({}))?.logo_key as string | null) ?? null;
      if (prev) {
        await settings.update({}, { $set: { logo_key: null, logo_content_type: null, logo_width: null, logo_height: null, logo_updated_at: null, updated_at: new Date() } });
        await this.audit.record(tx, { action: 'signature.logo_removed', resourceType: 'signature_settings' });
      }
      return prev;
    });
    if (old) await this.storage.remove(old).catch(() => undefined);
  }

  async openLogo(tenantId?: string) {
    const row = await this.db.tenant((tx) => tx.collection('signature_settings').findOne({}), tenantId ? { tenantId } : undefined) as { logo_key?: string | null; logo_content_type?: string | null } | undefined;
    if (!row?.logo_key || !row.logo_content_type) throw Errors.notFound('Logo');
    const f = await this.storage.open(row.logo_key).catch(() => { throw Errors.notFound('Logo'); });
    return { ...f, contentType: row.logo_content_type };
  }

  /** Everyone's signature and computers, for the people who manage the organisation. */
  async overview() {
    return this.db.tenant(async (tx) => {
      const employees = await tx.collection('employees').find({ status: { $ne: 'exited' } });
      const sigs = new Map((await tx.collection('employee_signatures').find({})).map((s) => [s.employee_id as string, s]));
      const live = await tx.collection('signature_agents').find({ revoked_at: null }, { sort: { created_at: 1 } });
      const byEmployee = new Map<string, Doc[]>();
      for (const a of live) byEmployee.set(a.employee_id as string, [...(byEmployee.get(a.employee_id as string) ?? []), a]);
      const time = (d: unknown) => (d instanceof Date ? d.getTime() : -Infinity);
      const people = employees
        .map((e) => {
          const s = sigs.get(e.id as string);
          const mine = byEmployee.get(e.id as string) ?? [];
          const applied = mine.map((a) => a.last_applied_at as Date | null).filter((d): d is Date => d instanceof Date);
          const failing = mine.filter((a) => a.last_error != null).sort((a, b) => time(b.last_seen_at) - time(a.last_seen_at))[0];
          return {
            id: e.id, name: displayName(e as never), employeeCode: e.employee_code, workEmail: n(e.work_email as string),
            template: n(s?.template as string), syncMode: n(s?.sync_mode as string), updatedAt: n(s?.updated_at as Date),
            computers: mine.length, lastAppliedAt: applied.length ? new Date(Math.max(...applied.map((d) => d.getTime()))) : null, lastError: n(failing?.last_error as string),
            sortKey: `${e.first_name} ${e.last_name ?? ''}`.toLowerCase(),
          };
        })
        .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))
        .map(({ sortKey: _, ...p }) => p);
      const agents = live.map((a) => ({ employeeId: a.employee_id as string, ...agentView(a) }));
      return { people, agents };
    });
  }

  async adminRevokeAgent(id: string) {
    await this.db.tenant(async (tx) => {
      const a = await tx.collection('signature_agents').findOne({ id });
      if (!a) throw Errors.notFound('Computer');
      if (!a.revoked_at) {
        await tx.collection('signature_agents').updateOne({ id }, { $set: { revoked_at: new Date() } });
        await this.audit.record(tx, { action: 'signature.agent_revoked', resourceType: 'signature_agent', resourceId: id, metadata: { employeeId: a.employee_id, name: a.name, by: 'admin' } });
      }
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // The signed-in person's own signature
  // ---------------------------------------------------------------------------------------------------------

  private async myEmployeeId(tx: Tx): Promise<string> {
    const s = await this.authz.subject(tx);
    if (!s.employeeId) throw Errors.badRequest('no_employee_record', 'Your login is not linked to an employee record in this workspace, so there is no signature to set up.');
    return s.employeeId;
  }

  private async person(tx: Tx, employeeId: string): Promise<PersonRow> {
    const e = await tx.collection('employees').findOne({ id: employeeId });
    if (!e) throw Errors.notFound('Employee');
    const t = (await tx.collection('tenants').findOne({}))!;
    const ds = e.current_designation_id ? await tx.collection('designations').findOne({ id: e.current_designation_id }, { projection: { name: 1 } }) : undefined;
    const d = e.current_department_id ? await tx.collection('departments').findOne({ id: e.current_department_id }, { projection: { name: 1 } }) : undefined;
    const le = e.current_legal_entity_id ? await tx.collection('legal_entities').findOne({ id: e.current_legal_entity_id }, { projection: { address: 1, legal_name: 1 } }) : undefined;
    return {
      id: e.id as string, display_name: displayName(e as never), work_email: n(e.work_email as string), phone: n(e.phone as string),
      designation: n(ds?.name as string), department: n(d?.name as string), photo_key: n(e.photo_key as string), photo_content_type: n(e.photo_content_type as string),
      photo_updated_at: n(e.photo_updated_at as Date), tenant_name: t.name as string, tenant_website: n(t.website as string), tenant_phone: n(t.contact_phone as string),
      entity_address: n(le?.address as string), entity_legal_name: n(le?.legal_name as string), timezone: n(t.timezone as string),
    };
  }

  private async signatureRow(tx: Tx, employeeId: string) {
    const s = await tx.collection('employee_signatures').findOne({ employee_id: employeeId });
    return s ? ({ template: s.template, options: s.options, sync_mode: n(s.sync_mode), sync_requested_at: n(s.sync_requested_at), updated_at: s.updated_at } as SignatureRow) : undefined;
  }

  /**
   * The person's details merged with the company's, as the renderer needs them. Images are given as `images`:
   * the caller decides their addresses (web links for the preview, files next to the .htm for Outlook).
   */
  private compose(p: PersonRow, s: SettingsRow, sig: SignatureRow | null | undefined, banners: CompanyBanner[] = []) {
    const options: SignatureOptions = signatureOptionsInput.parse(sig?.options ?? {});
    const template: SignatureTemplateKey = s.lock_template ? (isTemplate(s.default_template) ? s.default_template : 'classic') : sig && isTemplate(sig.template) ? sig.template : isTemplate(s.default_template) ? s.default_template : 'classic';
    const show = options.show;
    const photoOk = !!p.photo_key && OUTLOOK_IMAGE_TYPES.includes(p.photo_content_type ?? '') && show.photo;
    const logoOk = !!s.logo_key && show.logo;
    const base: SignatureBase = {
      fullName: p.display_name, designation: p.designation, department: p.department, company: s.company_name ?? p.tenant_name, email: p.work_email,
      phone: s.phone ?? p.tenant_phone, mobile: p.phone, website: s.website ?? p.tenant_website, address: s.address ?? p.entity_address, disclaimer: s.disclaimer,
      social: s.social ?? {}, brandColor: s.brand_color, accentColor: s.accent_color, logoWidth: s.logo_width, logoHeight: s.logo_height,
    };
    const today = todayIn(p.timezone ?? 'UTC');
    const picked = pickBanner(today, banners, options.wishes);
    const bannerImage = picked?.source.kind === 'company' && picked.source.banner.image ? { id: picked.source.banner.id, ...picked.source.banner.image } : null;
    const data = { ...composeSignatureData(base, options), banner: picked?.view ?? null };
    const syncMode: SignatureSyncMode = s.allow_employee_sync_choice && sig?.sync_mode ? sig.sync_mode : s.sync_mode;
    return {
      template, options, base, data, syncMode, today,
      images: {
        banner: bannerImage ? { id: bannerImage.id, ext: BANNER_EXT[bannerImage.contentType] ?? 'png', updatedAt: bannerImage.updatedAt } : null,
        photo: photoOk ? { ext: p.photo_content_type === 'image/png' ? 'png' : 'jpg', updatedAt: p.photo_updated_at } : null,
        logo: logoOk ? { ext: s.logo_content_type === 'image/png' ? 'png' : 'jpg', updatedAt: s.logo_updated_at } : null,
      },
      photoNotForOutlook: !!p.photo_key && !OUTLOOK_IMAGE_TYPES.includes(p.photo_content_type ?? ''),
    };
  }

  /** The signature exactly as Outlook gets it, and its version (a hash of the content). */
  private forOutlook(c: ReturnType<SignaturesService['compose']>) {
    const photoName = c.images.photo ? `photo.${c.images.photo.ext}` : null;
    const logoName = c.images.logo ? `logo.${c.images.logo.ext}` : null;
    const bannerName = c.images.banner ? `banner-${c.images.banner.id.slice(0, 8)}.${c.images.banner.ext}` : null;
    const banner = c.data.banner ? { ...c.data.banner, imageSrc: bannerName ? `${SIGNATURE_NAME}_files/${bannerName}` : null } : null;
    const r = renderSignature(c.template, { ...c.data, banner, photoSrc: photoName ? `${SIGNATURE_NAME}_files/${photoName}` : null, logoSrc: logoName ? `${SIGNATURE_NAME}_files/${logoName}` : null });
    const version = sha256([r.html, r.text, c.images.photo?.updatedAt?.toISOString() ?? '', c.images.logo?.updatedAt?.toISOString() ?? '', c.images.banner?.updatedAt ?? ''].join('\n')).slice(0, 32);
    const images = [
      ...(bannerName ? [{ name: bannerName, path: '/signature-agent/images/banner' }] : []),
      ...(photoName ? [{ name: photoName, path: '/signature-agent/images/photo' }] : []),
      ...(logoName ? [{ name: logoName, path: '/signature-agent/images/logo' }] : []),
    ];
    return { version, html: r.html, text: r.text, images };
  }

  private async composeFor(tx: Tx, employeeId: string) {
    const [p, s, sig, banners] = [await this.person(tx, employeeId), await this.settingsRow(tx), await this.signatureRow(tx, employeeId), await this.bannerList(tx)];
    return this.compose(p, s, sig, banners);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Festival, celebration and company banners (org:manage to change; everyone sees the enabled ones)
  // ---------------------------------------------------------------------------------------------------------

  private async bannerList(tx: Tx) {
    const rows = (await tx.collection('signature_banners').find({}, { sort: { created_at: 1 } })).map(bannerRow);
    // Dated banners first (by start), undated ones after, each in the order they were made.
    rows.sort((a, b) => (a.starts_on === b.starts_on ? 0 : a.starts_on === null ? 1 : b.starts_on === null ? -1 : a.starts_on < b.starts_on ? -1 : 1));
    return rows.map(bannerView);
  }

  async banners() {
    return this.db.tenant((tx) => this.bannerList(tx));
  }

  private bannerFields(input: SignatureBannerInput) {
    return {
      occasion_key: input.occasionKey ?? null, title: input.title, message: input.message, icon: input.icon ?? null, bg_color: input.bgColor, fg_color: input.fgColor,
      link_url: input.linkUrl ?? null, starts_on: input.startsOn ?? null, ends_on: input.endsOn ?? null, position: input.position, enabled: input.enabled,
    };
  }

  async createBanner(input: SignatureBannerInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const banners = tx.collection('signature_banners');
      if ((await banners.count({})) >= MAX_BANNERS) throw Errors.badRequest('too_many_banners', `A company can keep up to ${MAX_BANNERS} banners. Delete old ones first.`);
      if (input.occasionKey && (await banners.exists({ occasion_key: input.occasionKey }))) throw Errors.conflict('banner_exists', 'This festival is already on your list. Edit it instead.');
      const row = bannerRow(await banners.insert({ ...this.bannerFields(input), created_by: actor.membershipId }));
      await this.audit.record(tx, { action: 'signature.banner_created', resourceType: 'signature_banner', resourceId: row.id, changes: { ...input } });
      return bannerView(row);
    });
  }

  async updateBanner(id: string, input: SignatureBannerInput) {
    return this.db.tenant(async (tx) => {
      const banners = tx.collection('signature_banners');
      await banners.lock({ id });
      const prev = await banners.findOne({ id });
      if (!prev) throw Errors.notFound('Banner');
      if (input.occasionKey && input.occasionKey !== prev.occasion_key && (await banners.exists({ occasion_key: input.occasionKey }))) throw Errors.conflict('banner_exists', 'This festival is already on your list.');
      const row = bannerRow((await banners.updateAndGet({ id }, { $set: { ...this.bannerFields(input), updated_at: new Date() } }))!);
      await this.audit.record(tx, { action: 'signature.banner_updated', resourceType: 'signature_banner', resourceId: id, changes: { ...input } });
      return bannerView(row);
    });
  }

  async deleteBanner(id: string) {
    const key = await this.db.tenant(async (tx) => {
      const row = await tx.collection('signature_banners').findOne({ id });
      if (!row) throw Errors.notFound('Banner');
      await tx.collection('signature_banners').deleteOne({ id });
      await this.audit.record(tx, { action: 'signature.banner_deleted', resourceType: 'signature_banner', resourceId: id, metadata: { title: row.title } });
      return (row.image_key as string | null) ?? null;
    });
    if (key) await this.storage.remove(key).catch(() => undefined);
  }

  async setBannerImage(id: string, file: { mimetype: string; size: number; buffer: Buffer } | undefined) {
    if (!file) throw Errors.badRequest('file_required', 'Choose an image');
    if (!(BANNER_IMAGE_TYPES as readonly string[]).includes(file.mimetype)) throw Errors.badRequest('unsupported_type', 'Use a PNG, JPEG or GIF image: Outlook cannot show other types');
    if (file.size <= 0 || file.size > LOGO_MAX_BYTES) throw Errors.badRequest('file_too_large', 'Banner images can be up to 1 MB');
    if (!sniffMatches(file.mimetype, file.buffer.subarray(0, 512))) throw Errors.badRequest('content_mismatch', 'The file is not the image type it claims to be');
    const size = imageSize(file.buffer, file.mimetype);
    if (!size || size.width < 1 || size.height < 1 || size.width > 10000 || size.height > 10000) throw Errors.badRequest('unreadable_image', 'The image could not be read');
    const actor = requestContext.tenantActor();
    const key = this.storage.newKey(actor.tenantId);
    await this.storage.put(key, file.buffer, { upload: true });
    try {
      const { old, row } = await this.db.tenant(async (tx) => {
        const banners = tx.collection('signature_banners');
        await banners.lock({ id });
        const prev = await banners.findOne({ id });
        if (!prev) throw Errors.notFound('Banner');
        const now = new Date();
        const updated = bannerRow((await banners.updateAndGet({ id }, { $set: { image_key: key, image_content_type: file.mimetype, image_width: size.width, image_height: size.height, image_updated_at: now, updated_at: now } }))!);
        await this.audit.record(tx, { action: 'signature.banner_image_updated', resourceType: 'signature_banner', resourceId: id, metadata: { contentType: file.mimetype, ...size } });
        return { old: (prev.image_key as string | null) ?? null, row: updated };
      });
      if (old) await this.storage.remove(old).catch(() => undefined);
      return bannerView(row);
    } catch (e) {
      await this.storage.remove(key).catch(() => undefined);
      throw e;
    }
  }

  async removeBannerImage(id: string) {
    const old = await this.db.tenant(async (tx) => {
      const banners = tx.collection('signature_banners');
      await banners.lock({ id });
      const prev = await banners.findOne({ id });
      if (!prev) throw Errors.notFound('Banner');
      await banners.updateOne({ id }, { $set: { image_key: null, image_content_type: null, image_width: null, image_height: null, image_updated_at: null, updated_at: new Date() } });
      await this.audit.record(tx, { action: 'signature.banner_image_removed', resourceType: 'signature_banner', resourceId: id });
      return (prev.image_key as string | null) ?? null;
    });
    if (old) await this.storage.remove(old).catch(() => undefined);
  }

  async openBannerImage(id: string, tenantId?: string) {
    const row = await this.db.tenant((tx) => tx.collection('signature_banners').findOne({ id }), tenantId ? { tenantId } : undefined) as { image_key?: string | null; image_content_type?: string | null } | undefined;
    if (!row?.image_key || !row.image_content_type) throw Errors.notFound('Banner image');
    const f = await this.storage.open(row.image_key).catch(() => { throw Errors.notFound('Banner image'); });
    return { ...f, contentType: row.image_content_type };
  }

  async mine() {
    return this.db.tenant(async (tx) => {
      const employeeId = await this.myEmployeeId(tx);
      const [p, s, sig, banners] = [await this.person(tx, employeeId), await this.settingsRow(tx), await this.signatureRow(tx, employeeId), await this.bannerList(tx)];
      const c = this.compose(p, s, sig, banners);
      const outlook = this.forOutlook(c);
      const agents = (await tx.collection('signature_agents').find({ employee_id: employeeId, revoked_at: null }, { sort: { created_at: 1 } })).map(agentView);
      return {
        employeeId,
        saved: !!sig,
        template: c.template,
        options: c.options,
        syncMode: c.syncMode,
        ownSyncMode: sig?.sync_mode ?? null,
        syncRequestedAt: sig?.sync_requested_at ?? null,
        updatedAt: sig?.updated_at ?? null,
        base: c.base,
        data: c.data,
        canUsePhoto: !!p.photo_key && OUTLOOK_IMAGE_TYPES.includes(p.photo_content_type ?? ''),
        canUseLogo: !!s.logo_key,
        photoUpdatedAt: p.photo_updated_at,
        images: { photo: c.images.photo ? { updatedAt: c.images.photo.updatedAt } : null, logo: c.images.logo ? { updatedAt: c.images.logo.updatedAt } : null },
        photoNotForOutlook: c.photoNotForOutlook,
        today: c.today,
        banners: banners.filter((b) => b.enabled),
        version: outlook.version,
        company: { ...this.settingsView(s), companyName: s.company_name ?? p.tenant_name },
        agents: agents.map((a) => ({ ...a, upToDate: a.lastAppliedVersion === outlook.version })),
      };
    });
  }

  async saveMine(input: SaveSignatureInput) {
    return this.db.tenant(async (tx) => {
      const employeeId = await this.myEmployeeId(tx);
      const s = await this.settingsRow(tx);
      if (s.lock_template && input.template !== s.default_template) throw Errors.badRequest('template_locked', 'Your company uses one design for everyone. You can still change your own details and what is shown.');
      if (!s.allow_employee_sync_choice && input.syncMode && input.syncMode !== s.sync_mode) throw Errors.badRequest('sync_mode_locked', 'Your company decides how signatures are kept up to date.');
      const values = { template: input.template, options: input.options, sync_mode: input.syncMode ?? null };
      await tx.collection('employee_signatures').upsert({ employee_id: employeeId }, { employee_id: employeeId, ...values }, { $set: { ...values, updated_at: new Date() } });
      await this.audit.record(tx, { action: 'signature.updated', resourceType: 'employee', resourceId: employeeId, changes: { template: input.template, syncMode: input.syncMode } });
    }).then(() => this.mine());
  }

  /** "Sync now" from SampCrew: computers in automatic mode pick it up at their next check (within 30 minutes). */
  async requestSync() {
    await this.db.tenant(async (tx) => {
      const employeeId = await this.myEmployeeId(tx);
      const s = await this.settingsRow(tx);
      const now = new Date();
      await tx.collection('employee_signatures').upsert(
        { employee_id: employeeId },
        { employee_id: employeeId, template: isTemplate(s.default_template) ? s.default_template : 'classic', sync_requested_at: now },
        { $set: { sync_requested_at: now } },
      );
    });
    return this.mine();
  }

  /** A new computer: returns the installer (with the computer's own token) once; only its hash is kept. */
  async addAgent(name: string) {
    const token = AGENT_TOKEN_PREFIX + randomToken(32);
    const agent = await this.db.tenant(async (tx) => {
      const employeeId = await this.myEmployeeId(tx);
      const count = await tx.collection('signature_agents').count({ employee_id: employeeId, revoked_at: null });
      if (count >= 10) throw Errors.conflict('too_many_computers', 'You can connect up to 10 computers. Disconnect one you no longer use first.');
      const a = (await tx.collection('signature_agents').insert({
        employee_id: employeeId, name, token_hash: sha256(token), token_hint: token.slice(-4), created_by: requestContext.tenantActor().membershipId,
      })) as { id: string };
      await this.audit.record(tx, { action: 'signature.agent_added', resourceType: 'signature_agent', resourceId: a.id, metadata: { employeeId, name } });
      return a;
    });
    return { id: agent.id, fileName: 'SampCrew-Outlook-Signature-Setup.cmd', installer: buildInstaller({ apiUrl: this.config.API_PUBLIC_URL, token }) };
  }

  async revokeMine(id: string) {
    await this.db.tenant(async (tx) => {
      const employeeId = await this.myEmployeeId(tx);
      const a = await tx.collection('signature_agents').findOne({ id, employee_id: employeeId });
      if (!a) throw Errors.notFound('Computer');
      if (!a.revoked_at) {
        await tx.collection('signature_agents').updateOne({ id }, { $set: { revoked_at: new Date() } });
        await this.audit.record(tx, { action: 'signature.agent_revoked', resourceType: 'signature_agent', resourceId: id, metadata: { employeeId, name: a.name, by: 'self' } });
      }
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // The Windows sync (authenticated by the computer's own token)
  // ---------------------------------------------------------------------------------------------------------

  private async agentByToken(authorization: string | undefined): Promise<AgentRow> {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!token.startsWith(AGENT_TOKEN_PREFIX) || token.length > 120) throw Errors.unauthorized('Send the computer token as a Bearer token');
    const a = await this.db.platform(async (tx) => {
      const d = await tx.collection('signature_agents').findOne({ token_hash: sha256(token) });
      if (!d) return undefined;
      if (!(await tx.collection('tenants').exists({ id: d.tenant_id, status: 'active' }))) return undefined;
      if (!(await tx.collection('employees').exists({ id: d.employee_id, status: { $ne: 'exited' } }))) return undefined;
      return agentRow(d);
    });
    if (!a || a.revoked_at) throw Errors.unauthorized('This computer is not connected to SampCrew');
    // Email signatures are a plan module: computers stop syncing when the workspace's plan no longer includes it.
    if (!(await this.db.tenant((tx) => loadEntitlements(tx), { tenantId: a.tenant_id })).features.has('email_signatures')) throw Errors.featureNotInPlan('Email signatures');
    return a;
  }

  async agentSync(authorization: string | undefined, input: z.infer<typeof signatureAgentSyncInput>, ip: string | null) {
    const a = await this.agentByToken(authorization);
    return this.db.tenant(async (tx) => {
      const c = await this.composeFor(tx, a.employee_id);
      const sig = await this.signatureRow(tx, a.employee_id);
      const out = this.forOutlook(c);
      await tx.collection('signature_agents').updateOne({ id: a.id }, { $set: {
        last_seen_at: new Date(), last_trigger: input.trigger, last_ip: ip,
        ...(input.computerName != null ? { computer_name: input.computerName } : {}),
        ...(input.outlookVersions != null ? { outlook_versions: input.outlookVersions } : {}),
        ...(input.agentVersion != null ? { agent_version: input.agentVersion } : {}),
      } });
      // A "Sync now" from SampCrew sends the signature again even when the computer says it already has it.
      const requested = !!sig?.sync_requested_at;
      if (input.currentVersion === out.version && !requested && input.trigger !== 'install') return { status: 'unchanged' as const, version: out.version, mode: c.syncMode };
      return { status: 'update' as const, version: out.version, mode: c.syncMode, name: SIGNATURE_NAME, html: out.html, text: out.text, images: out.images };
    }, { tenantId: a.tenant_id });
  }

  async agentReport(authorization: string | undefined, input: z.infer<typeof signatureAgentReport>) {
    const a = await this.agentByToken(authorization);
    await this.db.tenant(async (tx) => {
      if (input.ok) {
        await tx.collection('signature_agents').updateOne({ id: a.id }, { $set: {
          last_applied_version: input.version, last_applied_at: new Date(), last_error: null, ...(input.outlookVersions != null ? { outlook_versions: input.outlookVersions } : {}),
        } });
        await tx.collection('employee_signatures').update({ employee_id: a.employee_id }, { $set: { sync_requested_at: null } });
      } else {
        await tx.collection('signature_agents').updateOne({ id: a.id }, { $set: { last_error: input.error ?? 'Unknown error' } });
      }
    }, { tenantId: a.tenant_id });
    return { ok: true };
  }

  async agentImage(authorization: string | undefined, kind: 'photo' | 'logo' | 'banner') {
    const a = await this.agentByToken(authorization);
    if (kind === 'logo') return this.openLogo(a.tenant_id);
    if (kind === 'banner') {
      // Today's banner for this person, the same one the last sync wrote into the signature.
      const c = await this.db.tenant((tx) => this.composeFor(tx, a.employee_id), { tenantId: a.tenant_id });
      if (!c.images.banner) throw Errors.notFound('Banner');
      return this.openBannerImage(c.images.banner.id, a.tenant_id);
    }
    const row = await this.db.tenant((tx) => tx.collection('employees').findOne({ id: a.employee_id }, { projection: { photo_key: 1, photo_content_type: 1 } }), { tenantId: a.tenant_id }) as { photo_key?: string | null; photo_content_type?: string | null } | undefined;
    if (!row?.photo_key || !OUTLOOK_IMAGE_TYPES.includes(row.photo_content_type ?? '')) throw Errors.notFound('Photo');
    const f = await this.storage.open(row.photo_key).catch(() => { throw Errors.notFound('Photo'); });
    return { ...f, contentType: row.photo_content_type! };
  }
}
