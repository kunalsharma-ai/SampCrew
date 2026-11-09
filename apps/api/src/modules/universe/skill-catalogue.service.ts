import { Injectable } from '@nestjs/common';
import {
  matchScore, type RequisitionSkills, type RequisitionSkillsInput, type SkillCatalogueEntry, type SkillCreateInput, type SkillMatch, type SkillUpdateInput,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantCovers, grantsFor } from '../../platform/authz/policy';
import { ieq, MongoService as DatabaseService, type TenantTx as Tx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { EMPLOYEE_FIELDS } from '../employees/employee-attrs';
import { displayName, fieldById } from '../employees/employee-view';
import { loadRequisition, reqAttrs } from '../recruitment/recruitment-common';

/**
 * The workspace's skill list (rename, group, merge, remove) and the skills a job asks for, with the people inside
 * the workspace who have them. Counts and matches only ever include people the viewer can already see.
 */
@Injectable()
export class SkillCatalogueService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
  ) {}

  async catalogue(): Promise<{ skills: SkillCatalogueEntry[]; canManage: boolean }> {
    return this.db.tenant(async (tx) => {
      const visible = new Set((await this.visibleEmployees(tx)).map((e) => e.id as string));
      const people = new Map<string, number>();
      for (const es of await tx.collection('employee_skills').find({}, { projection: { skill_id: 1, employee_id: 1 } })) {
        if (visible.has(es.employee_id)) people.set(es.skill_id, (people.get(es.skill_id) ?? 0) + 1);
      }
      const reqs = new Map<string, number>();
      for (const rs of await tx.collection('requisition_skills').find({}, { projection: { skill_id: 1 } })) reqs.set(rs.skill_id, (reqs.get(rs.skill_id) ?? 0) + 1);
      const skills: SkillCatalogueEntry[] = (await tx.collection('skills').find({}))
        .map((k) => ({ id: k.id, name: k.name, category: k.category ?? null, people: people.get(k.id) ?? 0, requisitions: reqs.get(k.id) ?? 0 }))
        .sort((a, b) => (a.category === b.category ? 0 : a.category === null ? 1 : b.category === null ? -1 : a.category.localeCompare(b.category)) || a.name.localeCompare(b.name));
      return { skills, canManage: this.manager(await this.authz.subject(tx)) };
    });
  }

  async create(input: SkillCreateInput) {
    return this.db.tenant(async (tx) => {
      this.requireManager(await this.authz.subject(tx));
      const name = input.name.replace(/\s+/g, ' ');
      const row = (await tx.collection('skills').exists({ name: ieq(name) })) ? undefined : await tx.collection('skills').insert({ name, category: input.category || null });
      if (!row) throw Errors.validation([{ path: ['name'], message: 'There is already a skill with this name' }]);
      await this.audit.record(tx, { action: 'skill.created', resourceType: 'skill', resourceId: row.id, changes: input });
      return this.entry(tx, row.id);
    });
  }

  async update(id: string, input: SkillUpdateInput) {
    return this.db.tenant(async (tx) => {
      this.requireManager(await this.authz.subject(tx));
      const skills = tx.collection('skills');
      await skills.lock({ id });
      const found = await skills.findOne({ id });
      if (!found) throw Errors.notFound('Skill');
      const before = { name: found.name as string, category: (found.category as string | null) ?? null };
      const name = input.name?.replace(/\s+/g, ' ') ?? before.name;
      if (name.toLowerCase() !== before.name.toLowerCase() && await skills.exists({ name: ieq(name), id: { $ne: id } })) {
        throw Errors.validation([{ path: ['name'], message: 'There is already a skill with this name: merge them instead' }]);
      }
      const category = input.category === undefined ? before.category : (input.category || null);
      await skills.updateOne({ id }, { $set: { name, category } });
      await this.audit.record(tx, { action: 'skill.updated', resourceType: 'skill', resourceId: id, changes: { before, after: { name, category } } });
      return this.entry(tx, id);
    });
  }

  /** Moves everyone (and every job) from one skill to another, keeping the higher level, then removes the first. */
  async merge(id: string, intoId: string) {
    if (id === intoId) throw Errors.validation([{ path: ['intoId'], message: 'Choose a different skill' }]);
    return this.db.tenant(async (tx) => {
      this.requireManager(await this.authz.subject(tx));
      await tx.collection('skills').lock({ id: { $in: [id, intoId] } });
      const both = (await tx.collection('skills').find({ id: { $in: [id, intoId] } })) as { id: string; name: string }[];
      const from = both.find((s) => s.id === id);
      const into = both.find((s) => s.id === intoId);
      if (!from) throw Errors.notFound('Skill');
      if (!into) throw Errors.validation([{ path: ['intoId'], message: 'Unknown skill' }]);
      const es = tx.collection('employee_skills');
      const holders = await es.find({ skill_id: id });
      for (const h of holders) {
        const values = { level: h.level, updated_by_membership_id: h.updated_by_membership_id ?? null, updated_at: h.updated_at };
        const existing = await es.findOne({ employee_id: h.employee_id, skill_id: intoId });
        if (!existing) await es.insert({ employee_id: h.employee_id, skill_id: intoId, ...values });
        else if (h.level > existing.level) await es.updateOne({ employee_id: h.employee_id, skill_id: intoId }, { $set: { level: h.level } });
      }
      const rs = tx.collection('requisition_skills');
      for (const q of await rs.find({ skill_id: id })) {
        const existing = await rs.findOne({ requisition_id: q.requisition_id, skill_id: intoId });
        if (!existing) await rs.insert({ requisition_id: q.requisition_id, skill_id: intoId, min_level: q.min_level });
        else if (q.min_level > existing.min_level) await rs.updateOne({ requisition_id: q.requisition_id, skill_id: intoId }, { $set: { min_level: q.min_level } });
      }
      await tx.collection('skills').deleteOne({ id });
      await this.audit.record(tx, { action: 'skill.merged', resourceType: 'skill', resourceId: intoId, changes: { from: from.name, into: into.name, holders: holders.length } });
      return this.entry(tx, intoId);
    });
  }

  async remove(id: string) {
    return this.db.tenant(async (tx) => {
      this.requireManager(await this.authz.subject(tx));
      const k = await tx.collection('skills').findOne({ id });
      if (!k) throw Errors.notFound('Skill');
      const s = { name: k.name as string, holders: await tx.collection('employee_skills').count({ skill_id: id }) };
      await tx.collection('skills').deleteOne({ id });
      await this.audit.record(tx, { action: 'skill.deleted', resourceType: 'skill', resourceId: id, changes: s });
      return { ok: true };
    });
  }

  // ---- Skills a job asks for ----------------------------------------------------------------------------------

  async forRequisition(requisitionId: string): Promise<RequisitionSkills> {
    return this.db.tenant(async (tx) => {
      const r = await loadRequisition(tx, requisitionId);
      await this.authz.require('requisitions:read', reqAttrs(r), tx);
      const s = await this.authz.subject(tx);
      const canEdit = grantsFor(s, 'requisitions:create').some((g) => grantCovers(s, g, reqAttrs(r))) && !['filled', 'closed', 'cancelled'].includes(r.status);
      return { ...(await this.matches(tx, requisitionId)), canEdit };
    });
  }

  async setForRequisition(requisitionId: string, input: RequisitionSkillsInput): Promise<RequisitionSkills> {
    return this.db.tenant(async (tx) => {
      const r = await loadRequisition(tx, requisitionId, true);
      await this.authz.require('requisitions:create', reqAttrs(r), tx);
      if (['filled', 'closed', 'cancelled'].includes(r.status)) throw Errors.conflict('requisition_locked', `A requisition that is ${r.status} cannot be changed`);
      const known = new Set((await tx.collection('skills').find({ id: { $in: input.skills.map((x) => x.skillId) } }, { projection: { _id: 1 } })).map((x) => x.id as string));
      const bad = input.skills.findIndex((x) => !known.has(x.skillId));
      if (bad >= 0) throw Errors.validation([{ path: ['skills', bad, 'skillId'], message: 'Unknown skill' }]);
      const rs = tx.collection('requisition_skills');
      const before = (await rs.find({ requisition_id: requisitionId })).map((x) => ({ skillId: x.skill_id as string, minLevel: x.min_level as number }));
      await rs.delete({ requisition_id: requisitionId });
      if (input.skills.length) await rs.insertMany(input.skills.map((x) => ({ requisition_id: requisitionId, skill_id: x.skillId, min_level: x.minLevel })));
      await this.audit.record(tx, { action: 'requisition.skills_updated', resourceType: 'job_requisition', resourceId: requisitionId, changes: { before, after: input.skills } });
      return { ...(await this.matches(tx, requisitionId)), canEdit: true };
    });
  }

  /** People the viewer can see, ranked by how well their skills cover the job's; the best 20 with any overlap. */
  private async matches(tx: Tx, requisitionId: string) {
    const wanted = await tx.collection('requisition_skills').find({ requisition_id: requisitionId });
    const names = await fieldById(tx, 'skills', wanted.map((x) => x.skill_id));
    const skills = wanted
      .map((x) => ({ skillId: x.skill_id as string, name: names.get(x.skill_id) ?? '', minLevel: x.min_level as number }))
      .sort((a, b) => b.minLevel - a.minLevel || a.name.localeCompare(b.name));
    if (!skills.length) return { skills, matches: [] as SkillMatch[] };
    const held = await tx.collection('employee_skills').find({ skill_id: { $in: skills.map((x) => x.skillId) } });
    const employees = await this.visibleEmployees(tx, { id: { $in: [...new Set(held.map((h) => h.employee_id as string))] } });
    const byId = new Map(employees.map((e) => [e.id as string, e]));
    const departments = await fieldById(tx, 'departments', employees.map((e) => e.current_department_id));
    const titles = await fieldById(tx, 'designations', employees.map((e) => e.current_designation_id));
    const rows = held.filter((h) => byId.has(h.employee_id)).map((h) => {
      const e = byId.get(h.employee_id)!;
      return {
        employeeId: e.id as string, name: displayName(e as never), title: titles.get(e.current_designation_id) ?? null,
        departmentName: departments.get(e.current_department_id) ?? null, skillId: h.skill_id as string, level: h.level as number,
      };
    });
    const people = new Map<string, { info: (typeof rows)[number]; held: Map<string, number> }>();
    for (const r of rows) {
      const p = people.get(r.employeeId) ?? { info: r, held: new Map() };
      p.held.set(r.skillId, r.level);
      people.set(r.employeeId, p);
    }
    const matches: SkillMatch[] = [...people.values()].map(({ info, held }) => ({
      employeeId: info.employeeId, name: info.name, title: info.title, departmentName: info.departmentName,
      ...matchScore(skills, held),
      skills: skills.map((k) => ({ skillId: k.skillId, name: k.name, minLevel: k.minLevel, level: held.get(k.skillId) ?? null })),
    })).filter((m) => m.score > 0).sort((a, b) => b.score - a.score || b.met - a.met || a.name.localeCompare(b.name)).slice(0, 20);
    return { skills, matches };
  }

  private async entry(tx: Tx, id: string) {
    const k = await tx.collection('skills').findOne({ id });
    return k ? { id: k.id as string, name: k.name as string, category: (k.category as string | null) ?? null } : undefined;
  }

  /** Current employees (not exited or pre-boarding) the viewer may see in the directory. */
  private async visibleEmployees(tx: Tx, extra: Record<string, unknown> = {}) {
    const scope = await this.authz.filter('employees:read', EMPLOYEE_FIELDS, tx);
    return tx.collection('employees').find({ $and: [scope, extra, { status: { $nin: ['exited', 'pre_boarding'] } }] });
  }

  /** Looking after the skill list is for people who may update every employee record. */
  private manager(s: Awaited<ReturnType<AuthzService['subject']>>) {
    return grantsFor(s, 'employees:update').some((g) => g.scope === 'tenant' && !Object.values(g.constraints ?? {}).some((v) => Array.isArray(v) && v.length));
  }

  private requireManager(s: Awaited<ReturnType<AuthzService['subject']>>) {
    if (!this.manager(s)) throw Errors.forbidden('Only people who look after every employee record can change the skill list');
  }
}
