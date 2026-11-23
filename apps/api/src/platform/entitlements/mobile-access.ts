import { type MobileAppConfig, type MobileLevel, mobileModule, mobileRouteAllowed, mobileRouteFor, normalizeMobileConfig } from '@crew/contracts';
import type { TenantTx } from '../database/mongo.service';
import { Errors } from '../http/errors';

export interface PublishedMobileConfig {
  config: MobileAppConfig;
  version: number;
  publishedAt: string | null;
}

/** The configuration phones follow: the last one published, or the starting configuration (version 0). */
export async function publishedMobileConfig(tx: TenantTx): Promise<PublishedMobileConfig> {
  const row = await tx.collection('mobile_app_configs').findOne({ key: 'workspace' }, { projection: { published: 1, version: 1, published_at: 1 } });
  return {
    config: normalizeMobileConfig((row?.published as MobileAppConfig | null | undefined) ?? null),
    version: (row?.version as number | undefined) ?? 0,
    publishedAt: row?.published_at instanceof Date ? row.published_at.toISOString() : null,
  };
}

/**
 * The level a person uses the mobile app at, from their access levels: Super Workspace, HR Workspace (company-wide
 * or for some HR Workspaces) or Employee Workspace. Old roles kept for rollback count for nothing, as everywhere.
 */
export async function mobileLevelOf(tx: TenantTx, membershipId: string): Promise<MobileLevel> {
  const held = await tx.collection('role_assignments').find({ membership_id: membershipId }, { projection: { role_id: 1 } });
  if (!held.length) return 'employee';
  const keys = new Set(
    (await tx.collection('roles').find({ id: { $in: held.map((a) => a.role_id) }, is_system: true, key: { $in: ['super_workspace', 'hr_workspace'] } }, { projection: { key: 1 } })).map((r) => r.key as string),
  );
  return keys.has('super_workspace') ? 'super' : keys.has('hr_workspace') ? 'hr' : 'employee';
}

const seen = new Map<string, string>();

/**
 * Layer 1 of mobile access for one phone request: a route the configuration governs is refused while none of its
 * owners is on for the person's level. Everything else (plan, switches above, permissions) is checked as usual.
 */
export async function requireMobileRoute(tx: TenantTx, membershipId: string, path: string, method: string): Promise<string | null> {
  const route = mobileRouteFor(path, method);
  if (!route) return null;
  const { config } = await publishedMobileConfig(tx);
  const level = await mobileLevelOf(tx, membershipId);
  const module = route.owners[0]!.split('.')[0]!;
  if (!mobileRouteAllowed(config, route, level)) throw Errors.mobileModuleOff(mobileModule(module)?.name ?? module);
  return module;
}

/**
 * Remembers once a day that a person used a module on the phone, for the "people use this" warning. Runs in its
 * own transaction after the access check; a failure here never fails the request.
 */
export async function recordMobileUsage(tx: TenantTx, membershipId: string, module: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const mark = `${membershipId}:${module}`;
  if (seen.get(mark) === day) return;
  if (seen.size > 50_000) seen.clear();
  const usage = tx.collection('mobile_module_usage');
  if (!(await usage.exists({ membership_id: membershipId, module, day }))) await usage.insert({ membership_id: membershipId, module, day });
  seen.set(mark, day);
}
