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
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
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
const BANNER_COLUMNS = `id, occasion_key, title, message, icon, bg_color, fg_color, link_url, to_char(starts_on, 'YYYY-MM-DD') as starts_on, to_char(ends_on, 'YYYY-MM-DD') as ends_on,
  position, enabled, image_key, image_content_type, image_width, image_height, image_updated_at, created_at, updated_at`;
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

const AGENT_COLUMNS = `id, name, token_hint as "tokenHint", computer_name as "computerName", outlook_versions as "outlookVersions", agent_version as "agentVersion",
  created_at as "createdAt", last_seen_at as "lastSeenAt", last_trigger as "lastTrigger", last_applied_version as "lastAppliedVersion",
  last_applied_at as "lastAppliedAt", last_error as "lastError", revoked_at as "revokedAt"`;

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
    return (await one<SettingsRow>(tx, 'select * from signature_settings')) ?? DEFAULT_SETTINGS;
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
      await tx.query(
        `insert into signature_settings (tenant_id, company_name, website, phone, address, brand_color, accent_color, default_template, disclaimer, social, sync_mode,
                                         allow_employee_sync_choice, lock_template, updated_by, updated_at)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
         on conflict (tenant_id) do update set company_name = $1, website = $2, phone = $3, address = $4, brand_color = $5, accent_color = $6, default_template = $7,
           disclaimer = $8, social = $9, sync_mode = $10, allow_employee_sync_choice = $11, lock_template = $12, updated_by = $13, updated_at = now()`,
        [input.companyName ?? null, input.website ?? null, input.phone ?? null, input.address ?? null, input.brandColor, input.accentColor, input.defaultTemplate,
          input.disclaimer ?? null, JSON.stringify(input.social ?? {}), input.syncMode, input.allowEmployeeSyncChoice, input.lockTemplate, actor.membershipId],
      );
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
      await tx.query(`insert into signature_settings (tenant_id) values (app_tenant_id()) on conflict do nothing`);
      const prev = (await one<{ logo_key: string | null }>(tx, 'select logo_key from signature_settings for update'))!.logo_key;
      await tx.query(
        'update signature_settings set logo_key = $1, logo_content_type = $2, logo_width = $3, logo_height = $4, logo_updated_at = now(), updated_by = $5, updated_at = now()',
        [key, file.mimetype, size.width, size.height, actor.membershipId],
      );
      await this.audit.record(tx, { action: 'signature.logo_updated', resourceType: 'signature_settings', metadata: { contentType: file.mimetype, ...size } });
      return prev;
    });
    if (old) await this.storage.remove(old).catch(() => undefined);
    return this.settings();
  }

  async removeLogo() {
    const old = await this.db.tenant(async (tx) => {
      const prev = (await one<{ logo_key: string | null }>(tx, 'select logo_key from signature_settings for update'))?.logo_key ?? null;
      if (prev) {
        await tx.query('update signature_settings set logo_key = null, logo_content_type = null, logo_width = null, logo_height = null, logo_updated_at = null, updated_at = now()');
        await this.audit.record(tx, { action: 'signature.logo_removed', resourceType: 'signature_settings' });
      }
      return prev;
    });
    if (old) await this.storage.remove(old).catch(() => undefined);
  }

  async openLogo(tenantId?: string) {
    const row = await this.db.tenant((tx) => one<{ logo_key: string | null; logo_content_type: string | null }>(tx, 'select logo_key, logo_content_type from signature_settings'), tenantId ? { tenantId } : undefined);
    if (!row?.logo_key || !row.logo_content_type) throw Errors.notFound('Logo');
    const f = await this.storage.open(row.logo_key).catch(() => { throw Errors.notFound('Logo'); });
    return { ...f, contentType: row.logo_content_type };
  }

  /** Everyone's signature and computers, for the people who manage the organisation. */
  async overview() {
    return this.db.tenant(async (tx) => {
      const people = await many<Record<string, unknown>>(
        tx,
        `select e.id, trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as name, e.employee_code as "employeeCode", e.work_email::text as "workEmail",
                s.template, s.sync_mode as "syncMode", s.updated_at as "updatedAt",
                (select count(*)::int from signature_agents a where a.employee_id = e.id and a.revoked_at is null) as computers,
                (select max(a.last_applied_at) from signature_agents a where a.employee_id = e.id and a.revoked_at is null) as "lastAppliedAt",
                (select a.last_error from signature_agents a where a.employee_id = e.id and a.revoked_at is null and a.last_error is not null order by a.last_seen_at desc nulls last limit 1) as "lastError"
           from employees e left join employee_signatures s on s.employee_id = e.id
          where e.status <> 'exited'
          order by lower(e.first_name || ' ' || e.last_name)`,
      );
      const agents = await many(tx, `select employee_id as "employeeId", ${AGENT_COLUMNS} from signature_agents where revoked_at is null order by created_at`);
      return { people, agents };
    });
  }

  async adminRevokeAgent(id: string) {
    await this.db.tenant(async (tx) => {
      const a = await one<AgentRow>(tx, 'select id, tenant_id, employee_id, name, revoked_at from signature_agents where id = $1', [id]);
      if (!a) throw Errors.notFound('Computer');
      if (!a.revoked_at) {
        await tx.query('update signature_agents set revoked_at = now() where id = $1', [id]);
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
    const p = await one<PersonRow>(
      tx,
      `select e.id, trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as display_name, e.work_email::text as work_email, e.phone,
              ds.name as designation, d.name as department, e.photo_key, e.photo_content_type, e.photo_updated_at,
              t.name as tenant_name, t.website as tenant_website, t.contact_phone as tenant_phone, le.address as entity_address, le.legal_name as entity_legal_name,
              t.timezone
         from employees e join tenants t on t.id = e.tenant_id
         left join designations ds on ds.id = e.current_designation_id left join departments d on d.id = e.current_department_id
         left join legal_entities le on le.id = e.current_legal_entity_id
        where e.id = $1`,
      [employeeId],
    );
    if (!p) throw Errors.notFound('Employee');
    return p;
  }

  private async signatureRow(tx: Tx, employeeId: string) {
    return one<SignatureRow>(tx, 'select template, options, sync_mode, sync_requested_at, updated_at from employee_signatures where employee_id = $1', [employeeId]);
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
    return (await many<BannerRow>(tx, `select ${BANNER_COLUMNS} from signature_banners order by starts_on nulls last, created_at`)).map(bannerView);
  }

  async banners() {
    return this.db.tenant((tx) => this.bannerList(tx));
  }

  private bannerParams(input: SignatureBannerInput) {
    return [input.occasionKey, input.title, input.message, input.icon ?? null, input.bgColor, input.fgColor, input.linkUrl ?? null, input.startsOn ?? null, input.endsOn ?? null, input.position, input.enabled];
  }

  async createBanner(input: SignatureBannerInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      if ((await one<{ n: number }>(tx, 'select count(*)::int as n from signature_banners'))!.n >= MAX_BANNERS) throw Errors.badRequest('too_many_banners', `A company can keep up to ${MAX_BANNERS} banners. Delete old ones first.`);
      if (input.occasionKey && (await one(tx, 'select 1 from signature_banners where occasion_key = $1', [input.occasionKey]))) throw Errors.conflict('banner_exists', 'This festival is already on your list. Edit it instead.');
      const row = (await one<BannerRow>(
        tx,
        `insert into signature_banners (tenant_id, occasion_key, title, message, icon, bg_color, fg_color, link_url, starts_on, ends_on, position, enabled, created_by)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning ${BANNER_COLUMNS}`,
        [...this.bannerParams(input), actor.membershipId],
      ))!;
      await this.audit.record(tx, { action: 'signature.banner_created', resourceType: 'signature_banner', resourceId: row.id, changes: { ...input } });
      return bannerView(row);
    });
  }

  async updateBanner(id: string, input: SignatureBannerInput) {
    return this.db.tenant(async (tx) => {
      const prev = await one<{ occasion_key: string | null }>(tx, 'select occasion_key from signature_banners where id = $1 for update', [id]);
      if (!prev) throw Errors.notFound('Banner');
      if (input.occasionKey && input.occasionKey !== prev.occasion_key && (await one(tx, 'select 1 from signature_banners where occasion_key = $1', [input.occasionKey]))) throw Errors.conflict('banner_exists', 'This festival is already on your list.');
      const row = (await one<BannerRow>(
        tx,
        `update signature_banners set occasion_key = $1, title = $2, message = $3, icon = $4, bg_color = $5, fg_color = $6, link_url = $7, starts_on = $8, ends_on = $9,
                position = $10, enabled = $11, updated_at = now() where id = $12 returning ${BANNER_COLUMNS}`,
        [...this.bannerParams(input), id],
      ))!;
      await this.audit.record(tx, { action: 'signature.banner_updated', resourceType: 'signature_banner', resourceId: id, changes: { ...input } });
      return bannerView(row);
    });
  }

  async deleteBanner(id: string) {
    const key = await this.db.tenant(async (tx) => {
      const row = await one<{ image_key: string | null; title: string }>(tx, 'delete from signature_banners where id = $1 returning image_key, title', [id]);
      if (!row) throw Errors.notFound('Banner');
      await this.audit.record(tx, { action: 'signature.banner_deleted', resourceType: 'signature_banner', resourceId: id, metadata: { title: row.title } });
      return row.image_key;
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
        const prev = await one<{ image_key: string | null }>(tx, 'select image_key from signature_banners where id = $1 for update', [id]);
        if (!prev) throw Errors.notFound('Banner');
        const updated = (await one<BannerRow>(
          tx,
          `update signature_banners set image_key = $2, image_content_type = $3, image_width = $4, image_height = $5, image_updated_at = now(), updated_at = now()
            where id = $1 returning ${BANNER_COLUMNS}`,
          [id, key, file.mimetype, size.width, size.height],
        ))!;
        await this.audit.record(tx, { action: 'signature.banner_image_updated', resourceType: 'signature_banner', resourceId: id, metadata: { contentType: file.mimetype, ...size } });
        return { old: prev.image_key, row: updated };
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
      const prev = await one<{ image_key: string | null }>(tx, 'select image_key from signature_banners where id = $1 for update', [id]);
      if (!prev) throw Errors.notFound('Banner');
      await tx.query('update signature_banners set image_key = null, image_content_type = null, image_width = null, image_height = null, image_updated_at = null, updated_at = now() where id = $1', [id]);
      await this.audit.record(tx, { action: 'signature.banner_image_removed', resourceType: 'signature_banner', resourceId: id });
      return prev.image_key;
    });
    if (old) await this.storage.remove(old).catch(() => undefined);
  }

  async openBannerImage(id: string, tenantId?: string) {
    const row = await this.db.tenant((tx) => one<{ image_key: string | null; image_content_type: string | null }>(tx, 'select image_key, image_content_type from signature_banners where id = $1', [id]), tenantId ? { tenantId } : undefined);
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
      const agents = await many(tx, `select ${AGENT_COLUMNS} from signature_agents where employee_id = $1 and revoked_at is null order by created_at`, [employeeId]);
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
        agents: agents.map((a) => ({ ...a, upToDate: (a as { lastAppliedVersion: string | null }).lastAppliedVersion === outlook.version })),
      };
    });
  }

  async saveMine(input: SaveSignatureInput) {
    return this.db.tenant(async (tx) => {
      const employeeId = await this.myEmployeeId(tx);
      const s = await this.settingsRow(tx);
      if (s.lock_template && input.template !== s.default_template) throw Errors.badRequest('template_locked', 'Your company uses one design for everyone. You can still change your own details and what is shown.');
      if (!s.allow_employee_sync_choice && input.syncMode && input.syncMode !== s.sync_mode) throw Errors.badRequest('sync_mode_locked', 'Your company decides how signatures are kept up to date.');
      await tx.query(
        `insert into employee_signatures (tenant_id, employee_id, template, options, sync_mode, updated_at) values (app_tenant_id(), $1, $2, $3, $4, now())
         on conflict (tenant_id, employee_id) do update set template = $2, options = $3, sync_mode = $4, updated_at = now()`,
        [employeeId, input.template, JSON.stringify(input.options), input.syncMode],
      );
      await this.audit.record(tx, { action: 'signature.updated', resourceType: 'employee', resourceId: employeeId, changes: { template: input.template, syncMode: input.syncMode } });
    }).then(() => this.mine());
  }

  /** "Sync now" from SampCrew: computers in automatic mode pick it up at their next check (within 30 minutes). */
  async requestSync() {
    await this.db.tenant(async (tx) => {
      const employeeId = await this.myEmployeeId(tx);
      const s = await this.settingsRow(tx);
      await tx.query(
        `insert into employee_signatures (tenant_id, employee_id, template, sync_requested_at) values (app_tenant_id(), $1, $2, now())
         on conflict (tenant_id, employee_id) do update set sync_requested_at = now()`,
        [employeeId, isTemplate(s.default_template) ? s.default_template : 'classic'],
      );
    });
    return this.mine();
  }

  /** A new computer: returns the installer (with the computer's own token) once; only its hash is kept. */
  async addAgent(name: string) {
    const token = AGENT_TOKEN_PREFIX + randomToken(32);
    const agent = await this.db.tenant(async (tx) => {
      const employeeId = await this.myEmployeeId(tx);
      const count = (await one<{ n: number }>(tx, 'select count(*)::int as n from signature_agents where employee_id = $1 and revoked_at is null', [employeeId]))!.n;
      if (count >= 10) throw Errors.conflict('too_many_computers', 'You can connect up to 10 computers. Disconnect one you no longer use first.');
      const a = (await one<{ id: string }>(
        tx,
        `insert into signature_agents (tenant_id, employee_id, name, token_hash, token_hint, created_by) values (app_tenant_id(), $1, $2, $3, $4, $5) returning id`,
        [employeeId, name, sha256(token), token.slice(-4), requestContext.tenantActor().membershipId],
      ))!;
      await this.audit.record(tx, { action: 'signature.agent_added', resourceType: 'signature_agent', resourceId: a.id, metadata: { employeeId, name } });
      return a;
    });
    return { id: agent.id, fileName: 'SampCrew-Outlook-Signature-Setup.cmd', installer: buildInstaller({ apiUrl: this.config.API_PUBLIC_URL, token }) };
  }

  async revokeMine(id: string) {
    await this.db.tenant(async (tx) => {
      const employeeId = await this.myEmployeeId(tx);
      const a = await one<AgentRow>(tx, 'select id, tenant_id, employee_id, name, revoked_at from signature_agents where id = $1 and employee_id = $2', [id, employeeId]);
      if (!a) throw Errors.notFound('Computer');
      if (!a.revoked_at) {
        await tx.query('update signature_agents set revoked_at = now() where id = $1', [id]);
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
    const a = await this.db.platform((tx) => one<AgentRow>(
      tx,
      `select a.id, a.tenant_id, a.employee_id, a.name, a.revoked_at from signature_agents a join tenants t on t.id = a.tenant_id join employees e on e.id = a.employee_id
        where a.token_hash = $1 and t.status = 'active' and e.status <> 'exited'`,
      [sha256(token)],
    ));
    if (!a || a.revoked_at) throw Errors.unauthorized('This computer is not connected to SampCrew');
    return a;
  }

  async agentSync(authorization: string | undefined, input: z.infer<typeof signatureAgentSyncInput>, ip: string | null) {
    const a = await this.agentByToken(authorization);
    return this.db.tenant(async (tx) => {
      const c = await this.composeFor(tx, a.employee_id);
      const sig = await this.signatureRow(tx, a.employee_id);
      const out = this.forOutlook(c);
      await tx.query(
        `update signature_agents set last_seen_at = now(), last_trigger = $2, computer_name = coalesce($3, computer_name), outlook_versions = coalesce($4, outlook_versions),
                agent_version = coalesce($5, agent_version), last_ip = $6 where id = $1`,
        [a.id, input.trigger, input.computerName ?? null, input.outlookVersions ?? null, input.agentVersion ?? null, ip],
      );
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
        await tx.query(`update signature_agents set last_applied_version = $2, last_applied_at = now(), last_error = null, outlook_versions = coalesce($3, outlook_versions) where id = $1`, [a.id, input.version, input.outlookVersions ?? null]);
        await tx.query('update employee_signatures set sync_requested_at = null where employee_id = $1', [a.employee_id]);
      } else {
        await tx.query('update signature_agents set last_error = $2 where id = $1', [a.id, input.error ?? 'Unknown error']);
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
    const row = await this.db.tenant((tx) => one<{ photo_key: string | null; photo_content_type: string | null }>(tx, 'select photo_key, photo_content_type from employees where id = $1', [a.employee_id]), { tenantId: a.tenant_id });
    if (!row?.photo_key || !OUTLOOK_IMAGE_TYPES.includes(row.photo_content_type ?? '')) throw Errors.notFound('Photo');
    const f = await this.storage.open(row.photo_key).catch(() => { throw Errors.notFound('Photo'); });
    return { ...f, contentType: row.photo_content_type! };
  }
}
