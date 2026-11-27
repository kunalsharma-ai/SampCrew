import { Injectable } from '@nestjs/common';
import {
  isValueList,
  libraryOf,
  MASTER_LIBRARY,
  MASTER_LIST_INFO,
  MASTER_LISTS,
  masterKey,
  masterNorm,
  systemValues,
  type MasterList,
  type MasterListSummary,
  type MasterValue,
  type MasterValueInput,
  type ValueList,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { hasPermission } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { countBy, MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { uniqueAs } from '../employees/unique';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const membership = () => {
  const a = requestContext.get()?.actor;
  return a?.kind === 'user' ? a.membershipId : null;
};
const clean = (s: string) => s.trim().replace(/\s+/g, ' ');

/** Lists stored in a real SampCrew model (name, archived_at), and what each one is called in messages and audits. */
const TABLE_LISTS = {
  department: { table: 'departments', resource: 'department', noun: 'department', usage: 'current_department_id' },
  job_title: { table: 'designations', resource: 'designation', noun: 'job title', usage: 'current_designation_id' },
  location: { table: 'locations', resource: 'location', noun: 'location', usage: 'current_location_id' },
  skill: { table: 'skills', resource: 'skill', noun: 'skill', usage: null },
} as const;
type TableList = keyof typeof TABLE_LISTS;
const tableList = (l: MasterList): l is TableList => l in TABLE_LISTS;

/**
 * Puts the library values of a list into the workspace the first time the list is used. Later releases may add to the
 * library; those additions appear under "Add from the library" and are never forced on a workspace.
 */
export async function ensureSeeded(tx: TenantTx, list: ValueList | 'skill'): Promise<void> {
  if (list === 'skill') {
    if (await tx.collection('skills').exists({})) return;
    const seen = new Set<string>();
    const rows = libraryOf('skill').filter((v) => (seen.has(v.label.toLowerCase()) ? false : (seen.add(v.label.toLowerCase()), true))).map((v) => ({ name: v.label, category: v.category }));
    await tx.collection('skills').insertMany(rows).catch((err) => { if ((err as { code?: string }).code !== '23505') throw err; });
    return;
  }
  const values = tx.collection('master_values');
  if (await values.exists({ list })) return;
  const seen = new Set<string>();
  const rows = MASTER_LIBRARY[list]
    .map((v, i) => ({ list, key: masterKey(v.label), label: v.label, category: v.category, code: v.code ?? null, level: v.level ?? null, origin: 'library', position: i }))
    .filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)));
  // Two requests seeding at once: the other one won, which is the same result.
  await values.insertMany(rows).catch((err) => { if ((err as { code?: string }).code !== '23505') throw err; });
}

export interface ListEntry { id: string; key: string; label: string; category: string | null; code: string | null; disabled: boolean }

/** Every value of a list (disabled ones too), for matching imported cells and custom field options. */
export async function listEntries(tx: TenantTx, list: MasterList): Promise<ListEntry[]> {
  if (isValueList(list)) {
    await ensureSeeded(tx, list);
    return (await tx.collection('master_values').find({ list }, { sort: { position: 1, label: 1 } }))
      .map((r) => ({ id: r.id, key: r.key, label: r.label, category: r.category ?? null, code: r.code ?? null, disabled: !!r.disabled_at }));
  }
  if (tableList(list)) {
    if (list === 'skill') await ensureSeeded(tx, 'skill');
    return (await tx.collection(TABLE_LISTS[list].table).find({}, { sort: { name: 1 } }))
      .map((r) => ({ id: r.id, key: r.id, label: r.name, category: r.category ?? null, code: r.code ?? null, disabled: !!r.archived_at }));
  }
  return systemValues(list as 'employment_type').map((v) => ({ id: v.key, key: v.key, label: v.label, category: null, code: null, disabled: false }));
}

/** The entry a typed value means: its name, key or code, without regard to case, spaces or punctuation. */
export function matchEntry(entries: ListEntry[], text: string): ListEntry | undefined {
  const n = masterNorm(text);
  if (!n) return undefined;
  return entries.find((e) => masterNorm(e.label) === n) ?? entries.find((e) => (e.code && masterNorm(e.code) === n) || e.key === masterKey(text));
}

/**
 * Master data management: lists, values, the library behind each list and the options a dropdown shows. Departments,
 * job titles, skills and locations are the real SampCrew records (departments, designations, the skills catalogue,
 * locations); every other list is master_values. Changing a list needs masterdata:manage (departments org:manage).
 * Values are disabled, never deleted, so records that hold one keep showing it. Every change is audited.
 */
@Injectable()
export class MasterDataService {
  constructor(private readonly db: DatabaseService, private readonly authz: AuthzService, private readonly audit: AuditService) {}

  private permissionFor(list: MasterList) {
    return list === 'department' ? 'org:manage' : 'masterdata:manage';
  }

  async mayEdit(tx: TenantTx, list: MasterList) {
    if (MASTER_LIST_INFO[list].storage === 'system' || list === 'location') return false;
    return hasPermission(await this.authz.subject(tx), this.permissionFor(list)).allowed;
  }

  async requireEdit(tx: TenantTx, list: MasterList) {
    if (MASTER_LIST_INFO[list].storage === 'system') throw Errors.badRequest('built_in_list', `${MASTER_LIST_INFO[list].label} are built in: payroll, leave and lifecycle rules depend on them.`);
    if (list === 'location') throw Errors.badRequest('use_organization', 'Locations need an address, time zone and geofence: add them in Organization > Locations.');
    await this.authz.require(this.permissionFor(list) as never, undefined, tx);
  }

  lists() {
    return this.db.tenant(async (tx): Promise<MasterListSummary[]> => {
      await this.authz.require('org:read', undefined, tx);
      const out: MasterListSummary[] = [];
      for (const list of MASTER_LISTS) {
        const entries = await listEntries(tx, list);
        out.push({ ...MASTER_LIST_INFO[list], active: entries.filter((e) => !e.disabled).length, disabled: entries.filter((e) => e.disabled).length, editable: await this.mayEdit(tx, list) });
      }
      return out;
    });
  }

  values(list: MasterList, q: { q?: string; category?: string; disabled: 'true' | 'false' | 'all' }) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('org:read', undefined, tx);
      const rows = await this.load(tx, list);
      const needle = q.q ? masterNorm(q.q) : '';
      const items = rows.filter((r) => (q.disabled === 'all' || (q.disabled === 'true') === r.disabled)
        && (!needle || masterNorm(r.label).includes(needle) || (!!r.code && masterNorm(r.code).includes(needle)))
        && (!q.category || r.category === q.category));
      const categories = [...new Set(rows.map((r) => r.category).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b));
      return { list: { ...MASTER_LIST_INFO[list], editable: await this.mayEdit(tx, list) }, categories, items };
    });
  }

  private async load(tx: TenantTx, list: MasterList): Promise<MasterValue[]> {
    const entries = await listEntries(tx, list);
    const library = new Map(libraryOf(list).map((l) => [masterNorm(l.label), l]));
    let usage = new Map<string, number>();
    let levels = new Map<string, number | null>();
    if (tableList(list)) {
      const t = TABLE_LISTS[list];
      if (t.usage) usage = await countBy(tx, 'employees', t.usage, entries.map((e) => e.id), { status: { $ne: 'exited' } });
      else usage = await countBy(tx, 'employee_skills', 'skill_id', entries.map((e) => e.id));
      if (list === 'job_title') levels = new Map((await tx.collection('designations').find({}, { projection: { level: 1 } })).map((r) => [r.id as string, (r.level as number | null) ?? null]));
    } else if (isValueList(list)) {
      levels = new Map((await tx.collection('master_values').find({ list }, { projection: { level: 1 } })).map((r) => [r.id as string, (r.level as number | null) ?? null]));
    }
    const system = MASTER_LIST_INFO[list].storage === 'system';
    return entries.map((e, i) => ({
      id: e.id, list, key: e.key, label: e.label, category: e.category ?? library.get(masterNorm(e.label))?.category ?? null, code: e.code,
      level: system ? i : levels.get(e.id) ?? null,
      origin: system ? 'system' : library.has(masterNorm(e.label)) ? 'library' : 'custom',
      disabled: e.disabled, usage: tableList(list) ? usage.get(e.id) ?? 0 : null,
    }));
  }

  /** Active values for a dropdown, for anyone signed in (custom fields and forms of every level use them). */
  options(list: MasterList) {
    return this.db.tenant(async (tx) => (await listEntries(tx, list)).filter((e) => !e.disabled).map((e) => ({ value: e.key, label: e.label, category: e.category })));
  }

  /** The library of a list, each value marked when the workspace already has it. */
  library(list: MasterList) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('org:read', undefined, tx);
      const have = new Set((await listEntries(tx, list)).map((r) => masterNorm(r.label)));
      return libraryOf(list).map((v) => ({ ...v, present: have.has(masterNorm(v.label)) }));
    });
  }

  create(list: MasterList, input: MasterValueInput) {
    return this.db.tenant(async (tx) => {
      await this.requireEdit(tx, list);
      const id = await this.createIn(tx, list, input, 'custom');
      return (await this.load(tx, list)).find((v) => v.id === id)!;
    });
  }

  /**
   * Adds a value inside a transaction the caller holds (the Master data page, an import adding a value it found).
   * The caller has checked the permission. Returns the new value's id.
   */
  async createIn(tx: TenantTx, list: MasterList, input: MasterValueInput, origin: 'library' | 'custom', via = 'master_data'): Promise<string> {
    const label = clean(input.label);
    const existing = matchEntry(await listEntries(tx, list), label);
    if (existing && masterNorm(existing.label) === masterNorm(label)) {
      throw Errors.conflict('value_exists', existing.disabled ? `${existing.label} is already in the list, disabled. Enable it instead.` : `${existing.label} is already in the list`);
    }
    const known = libraryOf(list).find((l) => masterNorm(l.label) === masterNorm(label));
    const category = input.category ?? known?.category ?? null;
    if (isValueList(list)) {
      let key = masterKey(label);
      for (let i = 2; await tx.collection('master_values').exists({ list, key }); i++) key = `${masterKey(label)}_${i}`;
      const position = await tx.collection('master_values').count({ list });
      const row = await tx.collection('master_values')
        .insert({ list, key, label, category, code: input.code ?? null, level: input.level ?? known?.level ?? null, origin, position, created_by_membership_id: membership() })
        .catch(uniqueAs('value_exists', `${label} is already in the list`));
      await this.audit.record(tx, { action: 'master_value.created', resourceType: 'master_value', resourceId: row.id, changes: { list, label, category, code: input.code ?? null }, metadata: { via } });
      return row.id as string;
    }
    if (list === 'job_title') {
      const row = await tx.collection('designations')
        .insert({ name: label, code: input.code ?? known?.code ?? null, level: input.level ?? known?.level ?? null, category })
        .catch(uniqueAs('value_exists', `${label} is already a job title`));
      await this.audit.record(tx, { action: 'designation.created', resourceType: 'designation', resourceId: row.id, changes: { name: label, code: row.code ?? null, level: row.level ?? null, category }, metadata: { via } });
      return row.id as string;
    }
    if (list === 'skill') {
      const row = await tx.collection('skills').insert({ name: label, category }).catch(uniqueAs('value_exists', `${label} is already a skill`));
      await this.audit.record(tx, { action: 'skill.created', resourceType: 'skill', resourceId: row.id, changes: { name: label, category }, metadata: { via } });
      return row.id as string;
    }
    if (list === 'department') {
      let code = input.code ?? known?.code ?? null;
      if (code && (await tx.collection('departments').exists({ code: { $regex: `^${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } }))) {
        if (input.code) throw Errors.conflict('code_taken', `The code ${code} is already used by another department`);
        code = null;
      }
      const row = await tx.collection('departments').insert({ name: label, code }).catch(uniqueAs('value_exists', `${label} is already a department`));
      await this.audit.record(tx, { action: 'department.created', resourceType: 'department', resourceId: row.id, changes: { name: label, code }, metadata: { via } });
      return row.id as string;
    }
    throw Errors.badRequest('built_in_list', 'This list cannot be added to');
  }

  update(list: MasterList, id: string, patch: Partial<MasterValueInput> & { disabled?: boolean }) {
    return this.db.tenant((tx) => this.updateIn(tx, list, id, patch));
  }

  /** update() inside a transaction the caller holds (a data import updates matched values). */
  async updateIn(tx: TenantTx, list: MasterList, id: string, patch: Partial<MasterValueInput> & { disabled?: boolean }, via = 'master_data'): Promise<MasterValue> {
    {
      await this.requireEdit(tx, list);
      if (patch.label !== undefined) {
        const clash = (await listEntries(tx, list)).find((e) => e.id !== id && masterNorm(e.label) === masterNorm(patch.label!));
        if (clash) throw Errors.conflict('value_exists', `${clash.label} is already in the list`);
      }
      if (isValueList(list)) {
        const before = await tx.collection('master_values').findOne({ id, list });
        if (!before) throw Errors.notFound('Value');
        const set: Doc = {};
        if (patch.label !== undefined) set.label = clean(patch.label);
        if (patch.category !== undefined) set.category = patch.category;
        if (patch.code !== undefined) set.code = patch.code;
        if (patch.level !== undefined) set.level = patch.level;
        if (patch.disabled !== undefined) set.disabled_at = patch.disabled ? (before.disabled_at ?? new Date()) : null;
        const after = await tx.collection('master_values').updateAndGet({ id }, { $set: set }).catch(uniqueAs('value_exists', 'That value is already in the list'));
        const changes = Object.fromEntries(Object.keys(set).map((k) => [k, { from: before[k] ?? null, to: after![k] ?? null }]));
        const action = patch.disabled === true && !before.disabled_at ? 'master_value.disabled' : patch.disabled === false && before.disabled_at ? 'master_value.enabled' : 'master_value.updated';
        await this.audit.record(tx, { action, resourceType: 'master_value', resourceId: id, changes, metadata: { list, via } });
      } else {
        const t = TABLE_LISTS[list as TableList];
        const before = await tx.collection(t.table).findOne({ id });
        if (!before) throw Errors.notFound(MASTER_LIST_INFO[list].singular);
        const set: Doc = {};
        if (patch.label !== undefined) set.name = clean(patch.label);
        if (patch.code !== undefined && list !== 'skill') set.code = patch.code || null;
        if (patch.level !== undefined && list === 'job_title') set.level = patch.level;
        if (patch.category !== undefined && list !== 'department') set.category = patch.category || null;
        if (patch.disabled !== undefined) {
          if (patch.disabled && !before.archived_at && list === 'department') {
            const busy = (await tx.collection('departments').count({ parent_id: id, archived_at: null })) + (await tx.collection('employees').count({ current_department_id: id, status: { $ne: 'exited' } }));
            if (busy) throw Errors.conflict('department_in_use', 'Move its people and sub-departments first: a department in use stays, so their records stay right.');
          }
          set.archived_at = patch.disabled ? (before.archived_at ?? new Date()) : null;
        }
        await tx.collection(t.table).updateOne({ id }, { $set: set }).catch(uniqueAs('value_exists', `Another ${t.noun} already has that name or code`));
        const after = (await tx.collection(t.table).findOne({ id }))!;
        const changes = Object.fromEntries(Object.keys(set).map((k) => [k, { from: before[k] ?? null, to: after[k] ?? null }]));
        const verb = patch.disabled === true && !before.archived_at ? 'archived' : patch.disabled === false && before.archived_at ? 'restored' : 'updated';
        await this.audit.record(tx, { action: `${t.resource}.${verb}`, resourceType: t.resource, resourceId: id, changes, metadata: { via } });
      }
      return (await this.load(tx, list)).find((v) => v.id === id)!;
    }
  }

  /** Adds chosen library values (those already present are skipped). */
  addFromLibrary(list: MasterList, labels: string[]) {
    return this.db.tenant(async (tx) => {
      await this.requireEdit(tx, list);
      const lib = libraryOf(list);
      const have = new Set((await listEntries(tx, list)).map((r) => masterNorm(r.label)));
      const added: string[] = [];
      const skipped: string[] = [];
      for (const l of labels) {
        const v = lib.find((x) => masterNorm(x.label) === masterNorm(l));
        if (!v) throw Errors.badRequest('not_in_library', `${l} is not in the library. Add it as your own value instead.`);
        if (have.has(masterNorm(v.label))) { skipped.push(v.label); continue; }
        await this.createIn(tx, list, { label: v.label, category: v.category, code: v.code ?? null, level: v.level ?? null }, 'library');
        have.add(masterNorm(v.label));
        added.push(v.label);
      }
      return { added, skipped };
    });
  }
}
