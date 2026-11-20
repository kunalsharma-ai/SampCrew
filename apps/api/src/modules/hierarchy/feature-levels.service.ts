import { Injectable } from '@nestjs/common';
import {
  BOOLEAN_FEATURES,
  FEATURE_PARTS,
  featurePart,
  isCoreFeature,
  isPlannedFeature,
  moduleOfFeature,
  type EmployeeFeatureRow,
  type EmployeeFeatureScope,
  type FeatureCell,
  type FeatureLevelRow,
  type FeatureTarget,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import type { Subject } from '../../platform/authz/policy';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { loadEntitlements, type Entitlements } from '../../platform/entitlements/entitlements.service';
import { Errors } from '../../platform/http/errors';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
type Audience = FeatureLevelRow['audience'];

/** Every switch in catalogue order: each module, then its pages and sub-areas. */
function catalogue(): { key: string; name: string; module: string; parent: string | null; audience: Audience; core: boolean }[] {
  const out: { key: string; name: string; module: string; parent: string | null; audience: Audience; core: boolean }[] = [];
  for (const f of BOOLEAN_FEATURES.filter((x) => !isPlannedFeature(x.key))) {
    out.push({ key: f.key, name: f.name, module: f.module, parent: null, audience: null, core: isCoreFeature(f.key) });
    for (const p of FEATURE_PARTS.filter((x) => x.feature === f.key)) out.push({ key: p.key, name: p.name, module: f.module, parent: f.key, audience: p.audience, core: false });
  }
  return out;
}

const list = (v: unknown) => new Set((v ?? []) as string[]);
/** Off here: the key itself, or (for a part) its module. */
const offIn = (set: Set<string>, key: string): 'self' | 'module' | null => (set.has(key) ? 'self' : featurePart(key) && set.has(moduleOfFeature(key)) ? 'module' : null);

/**
 * Feature management by level, below the Console:
 *  - the Super Workspace switches each module or page for the whole company, for the HR Workspace level and for the
 *    Employee Workspace level (an Employee Workspace switch it makes is locked for HR Workspace);
 *  - HR Workspace switches Employee Workspace features for the central group (company-wide HR) or for the HR
 *    Workspaces it runs, only among what the Super Workspace left on and gave that HR Workspace.
 * Entitlements apply these on every request (applyHierarchy), so a change reaches open sessions at once and the API
 * refuses what a screen hides. Switching off never deletes records. Every change is audited with its old and new list.
 */
@Injectable()
export class FeatureLevelsService {
  constructor(private readonly db: DatabaseService, private readonly authz: AuthzService, private readonly audit: AuditService) {}

  // Super Workspace -----------------------------------------------------------------------------------------------------

  /** Readable without a fresh MFA check (like the module list); changing it needs modules:manage, with MFA. */
  matrix() {
    return this.db.tenant(async (tx) => {
      await this.authz.require('tenant:read', undefined, tx);
      return this.matrixRows(tx);
    });
  }

  setLevels(changes: { key: string; target: FeatureTarget; enabled: boolean }[]) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('modules:manage', undefined, tx);
      const e = await loadEntitlements(tx);
      const row = (await tx.collection('workspace_modules').findOne({ key: 'workspace' })) ?? ({} as Doc);
      const lists = {
        company: list(row.disabled_features),
        hr: list(row.hr_level_off),
        employee: list(row.employee_level_off),
        employeeByHr: list(row.employee_level_off_by_hr),
      };
      const before = Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, [...v].sort()]));
      for (const c of changes) {
        const above = this.aboveCompany(e, lists.company, c.key);
        if (c.enabled && above) throw Errors.forbiddenCode('feature_restricted', `${this.nameOf(c.key)} is switched off by ${above === 'plan' ? 'your plan' : 'SAMPLEDGE'}, so it cannot be switched on here.`, { key: c.key });
        const set = c.target === 'company' ? lists.company : c.target === 'hr' ? lists.hr : lists.employee;
        if (c.enabled) {
          if (c.target !== 'company' && offIn(lists.company, c.key)) throw Errors.forbiddenCode('feature_restricted', `${this.nameOf(c.key)} is switched off for the whole company. Switch it on for the company first.`, { key: c.key });
          if (featurePart(c.key) && set.has(moduleOfFeature(c.key))) throw Errors.forbiddenCode('feature_restricted', `The ${this.nameOf(moduleOfFeature(c.key))} module is switched off here. Switch the module on first.`, { key: c.key });
          set.delete(c.key);
          // The Super Workspace decides over HR Workspace: switching on for Employee Workspace also lifts HR's switch.
          if (c.target === 'employee') lists.employeeByHr.delete(c.key);
        } else set.add(c.key);
      }
      const after = Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, [...v].sort()]));
      const fields = { disabled_features: after.company, hr_level_off: after.hr, employee_level_off: after.employee, employee_level_off_by_hr: after.employeeByHr };
      await tx.collection('workspace_modules').upsert({ key: 'workspace' }, { key: 'workspace', ...fields }, { $set: fields });
      const diff: Record<string, { from: string[]; to: string[] }> = {};
      for (const k of Object.keys(after)) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) diff[k] = { from: before[k]!, to: after[k]! };
      if (Object.keys(diff).length) {
        await this.audit.record(tx, { action: 'workspace.features_changed', resourceType: 'workspace_modules', resourceId: null, changes: diff, metadata: { level: 'super', switches: changes } });
      }
      return this.matrixRows(tx);
    });
  }

  private nameOf(key: string) {
    return featurePart(key)?.name ?? BOOLEAN_FEATURES.find((f) => f.key === key)?.name ?? key;
  }

  /** Why a feature is unavailable to the company from above its own switches: SAMPLEDGE (Console) or the plan. */
  private aboveCompany(e: Entitlements, companyOff: Set<string>, key: string): 'console' | 'plan' | null {
    if (e.features.has(key) || isCoreFeature(key)) return null;
    const reasonOf = (k: string) => e.blocked[k];
    const module = moduleOfFeature(key);
    for (const k of featurePart(key) ? [module, key] : [key]) {
      const r = reasonOf(k);
      if (r === 'platform_off' || r === 'workspace_off') return 'console';
    }
    // Switched off by the company itself (or its module is): not "above".
    if (offIn(companyOff, key)) return null;
    if (reasonOf(module) === 'admin_off') return null;
    return 'plan';
  }

  private async matrixRows(tx: TenantTx): Promise<{ items: FeatureLevelRow[] }> {
    const e = await loadEntitlements(tx);
    const row = (await tx.collection('workspace_modules').findOne({ key: 'workspace' })) ?? ({} as Doc);
    const company = list(row.disabled_features);
    const hr = list(row.hr_level_off);
    const employee = list(row.employee_level_off);
    const employeeByHr = list(row.employee_level_off_by_hr);
    const items = catalogue().map((f): FeatureLevelRow => {
      const above = this.aboveCompany(e, company, f.key);
      let companyCell: FeatureCell;
      if (f.core) companyCell = { on: true, indicator: 'active', editable: false };
      else if (above) companyCell = { on: false, indicator: 'restricted', restrictedBy: above, editable: false };
      else {
        const off = offIn(company, f.key);
        companyCell = off === 'self' ? { on: false, indicator: 'inactive', editable: true } : off === 'module' ? { on: false, indicator: 'restricted', restrictedBy: 'company', editable: false } : { on: true, indicator: 'active', editable: true };
      }
      const level = (set: Set<string>, extra?: Set<string>): FeatureCell => {
        if (f.core) return { on: true, indicator: 'inherited', editable: false };
        if (!companyCell.on) return { on: false, indicator: 'restricted', restrictedBy: companyCell.restrictedBy ?? 'company', editable: false };
        const off = offIn(set, f.key);
        if (off === 'self') return { on: false, indicator: 'inactive', setBy: 'super', editable: true };
        if (off === 'module') return { on: false, indicator: 'restricted', restrictedBy: 'super', editable: false };
        if (extra?.has(f.key)) return { on: false, indicator: 'inactive', setBy: 'hr', editable: true };
        return { on: true, indicator: 'inherited', editable: true };
      };
      return { key: f.key, name: f.name, module: f.module, parent: f.parent, audience: f.audience, company: companyCell, hr: level(hr), employee: level(employee, employeeByHr) };
    });
    return { items };
  }

  // HR Workspace > Employee Workspace ---------------------------------------------------------------------------------------

  /** The groups the person can switch Employee Workspace features for: the central group and/or HR Workspaces. */
  private async scopes(tx: TenantTx, s: Subject): Promise<EmployeeFeatureScope[]> {
    const grants = s.grants.filter((g) => g.permission === 'modules:assign');
    if (!grants.length) throw Errors.forbidden();
    const companyWide = grants.some((g) => !g.constraints.hrWorkspaceIds?.length);
    const ids = companyWide ? null : [...new Set(grants.flatMap((g) => g.constraints.hrWorkspaceIds ?? []))];
    const spaces = await tx.collection('hr_workspaces').find({ status: 'active', ...(ids ? { id: { $in: ids } } : {}) }, { sort: { name: 1 }, projection: { name: 1 } });
    return [...(companyWide ? [{ id: 'central', name: 'Central group' }] : []), ...spaces.map((w) => ({ id: w.id as string, name: w.name as string }))];
  }

  employeeFeatures(scope: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const scopes = await this.scopes(tx, s);
      const chosen = scopes.find((x) => x.id === scope) ?? scopes[0];
      if (!chosen) return { scopes, scope: null, items: [] };
      if (scope !== chosen.id && scope !== 'central') throw Errors.notFound('HR Workspace');
      return { scopes, scope: chosen, items: await this.employeeRows(tx, chosen.id) };
    });
  }

  setEmployeeFeatures(scope: string, changes: { key: string; enabled: boolean }[]) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const scopes = await this.scopes(tx, s);
      if (!scopes.some((x) => x.id === scope)) {
        await this.db.tenant((t) => this.audit.record(t, { action: 'delegation.denied', resourceType: 'employee_features', resourceId: scope === 'central' ? null : scope, metadata: { reason: 'out_of_scope', scope } })).catch(() => undefined);
        throw scope === 'central' ? Errors.forbidden() : Errors.notFound('HR Workspace');
      }
      const rows = new Map((await this.employeeRows(tx, scope)).map((r) => [r.key, r]));
      const w = scope === 'central' ? null : await tx.collection('hr_workspaces').findOne({ id: scope });
      const doc = scope === 'central' ? await tx.collection('workspace_modules').findOne({ key: 'workspace' }) : w;
      const field = scope === 'central' ? 'employee_level_off_by_hr' : 'employee_off_features';
      const off = list(doc?.[field]);
      const before = [...off].sort();
      for (const c of changes) {
        const r = rows.get(c.key);
        if (!r || (r.cell.indicator === 'restricted' && c.enabled)) {
          await this.db.tenant((t) => this.audit.record(t, { action: 'delegation.denied', resourceType: 'employee_features', resourceId: w?.id ?? null, metadata: { reason: 'restricted', key: c.key, scope } })).catch(() => undefined);
          throw Errors.forbiddenCode('feature_restricted', `${this.nameOf(c.key)} is switched off above HR Workspace, so it cannot be switched on for Employee Workspace here.`, { key: c.key });
        }
        if (c.enabled) off.delete(c.key);
        else off.add(c.key);
      }
      const after = [...off].sort();
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        if (scope === 'central') await tx.collection('workspace_modules').upsert({ key: 'workspace' }, { key: 'workspace', employee_level_off_by_hr: after }, { $set: { employee_level_off_by_hr: after } });
        else await tx.collection('hr_workspaces').updateOne({ id: scope }, { $set: { employee_off_features: after } });
        await this.audit.record(tx, {
          action: 'employee_features.changed', resourceType: scope === 'central' ? 'workspace_modules' : 'hr_workspace', resourceId: w?.id ?? null,
          changes: { switchedOff: { from: before, to: after } }, metadata: { scope: scope === 'central' ? 'central' : (w?.name as string) },
        });
      }
      return { scopes, scope: scopes.find((x) => x.id === scope)!, items: await this.employeeRows(tx, scope) };
    });
  }

  private async employeeRows(tx: TenantTx, scope: string): Promise<EmployeeFeatureRow[]> {
    const e = await loadEntitlements(tx);
    const row = (await tx.collection('workspace_modules').findOne({ key: 'workspace' })) ?? ({} as Doc);
    const company = list(row.disabled_features);
    const superOff = list(row.employee_level_off);
    const w = scope === 'central' ? null : await tx.collection('hr_workspaces').findOne({ id: scope });
    const controls = await tx.collection('tenant_access_controls').findOne({}, { projection: { non_delegable_features: 1 } });
    const kept = list(controls?.non_delegable_features);
    const given = w ? new Set(((w.features ?? []) as string[]).filter((k) => !kept.has(k))) : null;
    const hrOff = list(scope === 'central' ? row.employee_level_off_by_hr : w?.employee_off_features);
    return catalogue().map((f): EmployeeFeatureRow => {
      const base = { key: f.key, name: f.name, module: f.module, parent: f.parent, audience: f.audience };
      if (f.core) return { ...base, cell: { on: true, indicator: 'inherited', editable: false } };
      const above = this.aboveCompany(e, company, f.key);
      if (above) return { ...base, cell: { on: false, indicator: 'restricted', restrictedBy: above, editable: false } };
      if (offIn(company, f.key)) return { ...base, cell: { on: false, indicator: 'restricted', restrictedBy: 'company', editable: false } };
      if (offIn(superOff, f.key)) return { ...base, cell: { on: false, indicator: 'restricted', restrictedBy: 'super', editable: false } };
      if (given && !given.has(moduleOfFeature(f.key))) return { ...base, cell: { on: false, indicator: 'restricted', restrictedBy: 'super', editable: false } };
      const off = offIn(hrOff, f.key);
      if (off === 'self') return { ...base, cell: { on: false, indicator: 'inactive', setBy: 'hr', editable: true } };
      if (off === 'module') return { ...base, cell: { on: false, indicator: 'restricted', restrictedBy: 'hr_workspace', editable: false } };
      return { ...base, cell: { on: true, indicator: 'inherited', editable: true } };
    });
  }
}
