import { Injectable } from '@nestjs/common';
import {
  describeMobileChanges, type MobileAppConfig, type MobileAppPublishInput, type MobileLevel, MOBILE_LEVELS, MOBILE_MODULES, mobileKeyOn, normalizeMobileConfig,
  resolveMobileApp, validateMobileConfig,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { effectivePermissions } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { EntitlementsService, loadEntitlements } from '../../platform/entitlements/entitlements.service';
import { mobileLevelOf, publishedMobileConfig } from '../../platform/entitlements/mobile-access';
import { Errors } from '../../platform/http/errors';
import { MailerService } from '../../platform/notify/mailer.service';

const USAGE_DAYS = 30;
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : null);

/**
 * The Super Workspace's control over the centralized mobile app (Settings > Mobile app): a draft that is edited and
 * previewed, then published as a numbered version every phone follows. Every published version is kept, and an old
 * one can be restored (as a new version). Publishing only hides modules and features on phones: no record is
 * deleted, nothing changes on the Web Portal, and the person's own permissions still decide what they may do.
 */
@Injectable()
export class MobileAppService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly authz: AuthzService,
    private readonly entitlements: EntitlementsService,
    private readonly mailer: MailerService,
  ) {}

  /** The app for the signed-in person: both layers applied. The phone asks for this on start, on return and every minute. */
  async mine(knownVersion?: number) {
    const actor = requestContext.tenantActor();
    // Whether email can be sent at all, so the phone shows a setup state instead of an empty inbox. Never the settings.
    const email = await this.mailer.isConfigured().catch(() => false);
    return this.db.tenant(async (tx) => {
      const pub = await publishedMobileConfig(tx);
      const level = await mobileLevelOf(tx, actor.membershipId);
      const ent = await this.entitlements.current(tx);
      const perms = effectivePermissions(await this.authz.subject(tx));
      const app = resolveMobileApp({ ...pub, level, features: ent.features, can: (p) => Boolean(perms[p]) });
      return { ...app, setup: { email }, unchanged: knownVersion !== undefined && knownVersion === pub.version };
    });
  }

  async overview() {
    return this.db.tenant(async (tx) => {
      const row = await tx.collection('mobile_app_configs').findOne({ key: 'workspace' });
      const pub = await publishedMobileConfig(tx);
      const draft = row?.draft ? normalizeMobileConfig(row.draft as MobileAppConfig) : pub.config;
      const company = await this.companyFeatures(tx);
      const versions = await tx.collection('mobile_app_config_versions').find({}, { sort: { version: -1 }, limit: 1, projection: { version: 1 } });
      const enabled = (c: MobileAppConfig) => MOBILE_MODULES.filter((m) => c.modules[m.key]?.enabled).length;
      return {
        catalogue: MOBILE_MODULES.map((m) => ({ key: m.key, available: !m.entitlement || company.has(m.entitlement) })),
        published: { config: pub.config, version: pub.version, publishedAt: pub.publishedAt, publishedBy: await this.nameOf(tx, row?.published_by as string | undefined) },
        draft: {
          config: draft,
          revision: (row?.draft_revision as number | undefined) ?? 0,
          updatedAt: iso(row?.draft_updated_at),
          updatedBy: await this.nameOf(tx, row?.draft_updated_by as string | undefined),
          changes: describeMobileChanges(pub.config, draft),
          issues: validateMobileConfig(draft, { features: company }),
        },
        stats: {
          totalModules: MOBILE_MODULES.length,
          enabledModules: enabled(pub.config),
          disabledModules: MOBILE_MODULES.length - enabled(pub.config),
          latestVersion: (versions[0]?.version as number | undefined) ?? 0,
          status: row?.draft && describeMobileChanges(pub.config, draft).length ? 'draft_pending' : !pub.version ? 'default' : 'published',
        },
        usage: await this.usage(tx),
      };
    });
  }

  async saveDraft(config: MobileAppConfig) {
    const actor = requestContext.tenantActor();
    const clean = normalizeMobileConfig(config);
    await this.db.tenant(async (tx) => {
      const coll = tx.collection('mobile_app_configs');
      const set = { draft: clean, draft_updated_at: new Date(), draft_updated_by: actor.membershipId };
      if (await coll.exists({ key: 'workspace' })) await coll.updateOne({ key: 'workspace' }, { $set: set, $inc: { draft_revision: 1 } });
      else await coll.insert({ key: 'workspace', ...set, draft_revision: 1, version: 0 });
      await this.audit.record(tx, { action: 'mobile_app.draft_saved', resourceType: 'mobile_app_config', metadata: { changes: describeMobileChanges((await publishedMobileConfig(tx)).config, clean).slice(0, 40) } });
    });
    return this.overview();
  }

  async discardDraft() {
    await this.db.tenant(async (tx) => {
      await tx.collection('mobile_app_configs').updateOne({ key: 'workspace' }, { $set: { draft: null, draft_updated_at: new Date() }, $inc: { draft_revision: 1 } });
      await this.audit.record(tx, { action: 'mobile_app.draft_discarded', resourceType: 'mobile_app_config' });
    });
    return this.overview();
  }

  async publish(input: MobileAppPublishInput) {
    const actor = requestContext.tenantActor();
    const out = await this.db.tenant(async (tx) => {
      const row = await tx.collection('mobile_app_configs').findOne({ key: 'workspace' });
      if (!row?.draft) throw Errors.conflict('no_draft', 'There is nothing to publish: save your changes as a draft first.');
      if ((row.draft_revision as number) !== input.draftRevision) throw Errors.conflict('draft_changed', 'Someone changed the draft since you opened it. Reload to see their changes, then publish.');
      const draft = normalizeMobileConfig(row.draft as MobileAppConfig);
      const company = await this.companyFeatures(tx);
      const errors = validateMobileConfig(draft, { features: company }).filter((i) => i.severity === 'error');
      if (errors.length) throw Errors.badRequest('mobile_config_invalid', errors.map((e) => e.message).join(' '));
      const before = (await publishedMobileConfig(tx)).config;
      const hiding = await this.hidingInUse(tx, before, draft);
      if (hiding.length && !input.confirmHidingInUse) {
        throw Errors.conflict('modules_in_use', `People used ${hiding.map((h) => `${h.name} (${h.people})`).join(', ')} on their phones in the last ${USAGE_DAYS} days. Confirm to hide it anyway; no data is deleted.`);
      }
      return this.publishVersion(tx, draft, before, input.note, null, actor.membershipId);
    });
    const o = await this.overview();
    return { ...o, published: { ...o.published, changes: out.changes } };
  }

  /** Restores an old version: it is published again as a new version (the history keeps both). */
  async restore(version: number, note: string) {
    const actor = requestContext.tenantActor();
    const out = await this.db.tenant(async (tx) => {
      const old = await tx.collection('mobile_app_config_versions').findOne({ version });
      if (!old) throw Errors.notFound('Configuration version');
      const config = normalizeMobileConfig(old.config as MobileAppConfig);
      const errors = validateMobileConfig(config).filter((i) => i.severity === 'error');
      if (errors.length) throw Errors.badRequest('mobile_config_invalid', errors.map((e) => e.message).join(' '));
      return this.publishVersion(tx, config, (await publishedMobileConfig(tx)).config, note || `Restored version ${version}`, version, actor.membershipId);
    });
    const o = await this.overview();
    return { ...o, published: { ...o.published, changes: out.changes } };
  }

  async versions() {
    return this.db.tenant(async (tx) => {
      const rows = await tx.collection('mobile_app_config_versions').find({}, { sort: { version: -1 }, limit: 100, projection: { config: 0 } });
      return rows.map((r) => ({ version: r.version, publishedAt: iso(r.published_at), publishedBy: r.published_by_name || null, note: r.note, changes: r.changes ?? [], restoredFrom: r.restored_from ?? null }));
    });
  }

  async version(version: number) {
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('mobile_app_config_versions').findOne({ version });
      if (!r) throw Errors.notFound('Configuration version');
      return { version: r.version, publishedAt: iso(r.published_at), publishedBy: r.published_by_name || null, note: r.note, changes: r.changes ?? [], config: normalizeMobileConfig(r.config as MobileAppConfig) };
    });
  }

  /**
   * Read-only preview of the app for a level, with the company's modules and the level's switches above, but no
   * individual's permissions: it never shows or grants another person's data.
   */
  async preview(level: MobileLevel, source: 'draft' | 'published') {
    return this.db.tenant(async (tx) => {
      const row = await tx.collection('mobile_app_configs').findOne({ key: 'workspace' });
      const pub = await publishedMobileConfig(tx);
      const config = source === 'draft' && row?.draft ? normalizeMobileConfig(row.draft as MobileAppConfig) : pub.config;
      const features = await this.companyFeatures(tx, level);
      return resolveMobileApp({ config, version: source === 'draft' ? pub.version + 1 : pub.version, publishedAt: pub.publishedAt, level, features });
    });
  }

  private async publishVersion(tx: TenantTx, config: MobileAppConfig, before: MobileAppConfig, note: string, restoredFrom: number | null, by: string) {
    const coll = tx.collection('mobile_app_configs');
    const last = await tx.collection('mobile_app_config_versions').find({}, { sort: { version: -1 }, limit: 1, projection: { version: 1 } });
    const version = ((last[0]?.version as number | undefined) ?? 0) + 1;
    const changes = describeMobileChanges(before, config);
    const now = new Date();
    await tx.collection('mobile_app_config_versions').insert({ version, config, note, changes, published_by: by, published_by_name: (await this.nameOf(tx, by)) ?? '', published_at: now, restored_from: restoredFrom });
    const set = { published: config, version, published_at: now, published_by: by, draft: null, draft_updated_at: now };
    if (await coll.exists({ key: 'workspace' })) await coll.updateOne({ key: 'workspace' }, { $set: set, $inc: { draft_revision: 1 } });
    else await coll.insert({ key: 'workspace', ...set, draft_revision: 1 });
    await this.audit.record(tx, {
      action: restoredFrom ? 'mobile_app.restored' : 'mobile_app.published',
      resourceType: 'mobile_app_config',
      metadata: { version, note, restoredFrom, changes: changes.slice(0, 40) },
    });
    return { version, publishedAt: now.toISOString(), changes };
  }

  /** Modules this change hides from a level that people at that level used on their phones lately. */
  private async hidingInUse(tx: TenantTx, before: MobileAppConfig, after: MobileAppConfig) {
    const usage = await this.usage(tx);
    const out: { module: string; name: string; people: number }[] = [];
    for (const m of MOBILE_MODULES) {
      const lost = MOBILE_LEVELS.filter((l) => mobileKeyOn(before, m.key, l) && !mobileKeyOn(after, m.key, l));
      const people = usage[m.key] ?? 0;
      if (lost.length && people > 0) out.push({ module: m.key, name: m.name, people });
    }
    return out;
  }

  /** People who used each module on a phone in the last 30 days. */
  private async usage(tx: TenantTx): Promise<Record<string, number>> {
    const since = new Date(Date.now() - USAGE_DAYS * 86_400_000).toISOString().slice(0, 10);
    const rows = await tx.collection('mobile_module_usage').find({ day: { $gte: since } }, { projection: { module: 1, membership_id: 1 } });
    const per = new Map<string, Set<string>>();
    for (const r of rows) {
      const set = per.get(r.module as string) ?? new Set<string>();
      set.add(r.membership_id as string);
      per.set(r.module as string, set);
    }
    // Old rows are of no use; keep the collection small.
    const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    await tx.collection('mobile_module_usage').delete({ day: { $lt: cutoff } }).catch(() => undefined);
    return Object.fromEntries([...per].map(([k, v]) => [k, v.size]));
  }

  /** What the company has in its plan and switches for phones (and, for a level, that level's switches too). */
  private async companyFeatures(tx: TenantTx, level?: MobileLevel): Promise<Set<string>> {
    const ent = await loadEntitlements(tx, undefined, 'mobile');
    if (!level || level === 'super') return ent.features;
    const own = await tx.collection('workspace_modules').findOne({ key: 'workspace' }, { projection: { hr_level_off: 1, employee_level_off: 1 } });
    const off = new Set<string>(((level === 'hr' ? own?.hr_level_off : own?.employee_level_off) ?? []) as string[]);
    return new Set([...ent.features].filter((k) => !off.has(k) && !off.has(k.split('.')[0]!)));
  }

  private async nameOf(tx: TenantTx, membershipId?: string | null): Promise<string | null> {
    if (!membershipId) return null;
    const m = await tx.collection('memberships').findOne({ id: membershipId }, { projection: { user_id: 1 } });
    if (!m) return null;
    const u = await (await tx.users()).findOne({ id: m.user_id }, { projection: { full_name: 1 } });
    return (u?.full_name as string | undefined) ?? null;
  }
}
