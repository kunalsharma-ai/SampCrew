import { Injectable } from '@nestjs/common';
import {
  matchScore, type RequisitionSkills, type RequisitionSkillsInput, type SkillCatalogueEntry, type SkillCreateInput, type SkillMatch, type SkillUpdateInput,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantCovers, grantsFor } from '../../platform/authz/policy';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { EMPLOYEE_SCOPE } from '../employees/employee-attrs';
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
      const params: unknown[] = [];
      const scope = await this.authz.predicate('employees:read', EMPLOYEE_SCOPE, params, tx);
      const skills = await many<SkillCatalogueEntry>(
        tx,
        `select k.id, k.name::text as name, k.category,
                (select count(*)::int from employee_skills es join employees e on e.id = es.employee_id
                  where es.skill_id = k.id and e.status not in ('exited', 'pre_boarding') and ${scope}) as people,
                (select count(*)::int from requisition_skills rs where rs.skill_id = k.id) as requisitions
           from skills k order by k.category nulls last, k.name`,
        params,
      );
      return { skills, canManage: this.manager(await this.authz.subject(tx)) };
    });
  }

  async create(input: SkillCreateInput) {
    return this.db.tenant(async (tx) => {
      this.requireManager(await this.authz.subject(tx));
      const row = await one<{ id: string }>(
        tx, `insert into skills (tenant_id, name, category) values (app_tenant_id(), $1, $2) on conflict (tenant_id, name) do nothing returning id`,
        [input.name.replace(/\s+/g, ' '), input.category || null],
      );
      if (!row) throw Errors.validation([{ path: ['name'], message: 'There is already a skill with this name' }]);
      await this.audit.record(tx, { action: 'skill.created', resourceType: 'skill', resourceId: row.id, changes: input });
      return this.entry(tx, row.id);
    });
  }

  async update(id: string, input: SkillUpdateInput) {
    return this.db.tenant(async (tx) => {
      this.requireManager(await this.authz.subject(tx));
      const before = await one<{ name: string; category: string | null }>(tx, `select name::text as name, category from skills where id = $1 for update`, [id]);
      if (!before) throw Errors.notFound('Skill');
      const name = input.name?.replace(/\s+/g, ' ') ?? before.name;
      if (name.toLowerCase() !== before.name.toLowerCase() && await one(tx, `select 1 from skills where name = $1 and id <> $2`, [name, id])) {
        throw Errors.validation([{ path: ['name'], message: 'There is already a skill with this name: merge them instead' }]);
      }
      const category = input.category === undefined ? before.category : (input.category || null);
      await tx.query(`update skills set name = $2, category = $3 where id = $1`, [id, name, category]);
      await this.audit.record(tx, { action: 'skill.updated', resourceType: 'skill', resourceId: id, changes: { before, after: { name, category } } });
      return this.entry(tx, id);
    });
  }

  /** Moves everyone (and every job) from one skill to another, keeping the higher level, then removes the first. */
  async merge(id: string, intoId: string) {
    if (id === intoId) throw Errors.validation([{ path: ['intoId'], message: 'Choose a different skill' }]);
    return this.db.tenant(async (tx) => {
      this.requireManager(await this.authz.subject(tx));
      const both = await many<{ id: string; name: string }>(tx, `select id, name::text as name from skills where id = any($1::uuid[]) for update`, [[id, intoId]]);
      const from = both.find((s) => s.id === id);
      const into = both.find((s) => s.id === intoId);
      if (!from) throw Errors.notFound('Skill');
      if (!into) throw Errors.validation([{ path: ['intoId'], message: 'Unknown skill' }]);
      const moved = await tx.query(
        `insert into employee_skills (tenant_id, employee_id, skill_id, level, updated_by_membership_id, updated_at)
         select tenant_id, employee_id, $2, level, updated_by_membership_id, updated_at from employee_skills where skill_id = $1
         on conflict (tenant_id, employee_id, skill_id) do update set level = greatest(employee_skills.level, excluded.level)`,
        [id, intoId],
      );
      await tx.query(
        `insert into requisition_skills (tenant_id, requisition_id, skill_id, min_level)
         select tenant_id, requisition_id, $2, min_level from requisition_skills where skill_id = $1
         on conflict (tenant_id, requisition_id, skill_id) do update set min_level = greatest(requisition_skills.min_level, excluded.min_level)`,
        [id, intoId],
      );
      await tx.query(`delete from skills where id = $1`, [id]);
      await this.audit.record(tx, { action: 'skill.merged', resourceType: 'skill', resourceId: intoId, changes: { from: from.name, into: into.name, holders: moved.rowCount } });
      return this.entry(tx, intoId);
    });
  }

  async remove(id: string) {
    return this.db.tenant(async (tx) => {
      this.requireManager(await this.authz.subject(tx));
      const s = await one<{ name: string; holders: number }>(
        tx, `select k.name::text as name, (select count(*)::int from employee_skills where skill_id = k.id) as holders from skills k where k.id = $1`, [id],
      );
      if (!s) throw Errors.notFound('Skill');
      await tx.query(`delete from skills where id = $1`, [id]);
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
      const known = new Set((await many<{ id: string }>(tx, `select id from skills where id = any($1::uuid[])`, [input.skills.map((x) => x.skillId)])).map((x) => x.id));
      const bad = input.skills.findIndex((x) => !known.has(x.skillId));
      if (bad >= 0) throw Errors.validation([{ path: ['skills', bad, 'skillId'], message: 'Unknown skill' }]);
      const before = await many<{ skillId: string; minLevel: number }>(tx, `select skill_id as "skillId", min_level as "minLevel" from requisition_skills where requisition_id = $1`, [requisitionId]);
      await tx.query(`delete from requisition_skills where requisition_id = $1`, [requisitionId]);
      for (const x of input.skills) {
        await tx.query(`insert into requisition_skills (tenant_id, requisition_id, skill_id, min_level) values (app_tenant_id(), $1, $2, $3)`, [requisitionId, x.skillId, x.minLevel]);
      }
      await this.audit.record(tx, { action: 'requisition.skills_updated', resourceType: 'job_requisition', resourceId: requisitionId, changes: { before, after: input.skills } });
      return { ...(await this.matches(tx, requisitionId)), canEdit: true };
    });
  }

  /** People the viewer can see, ranked by how well their skills cover the job's; the best 20 with any overlap. */
  private async matches(tx: Tx, requisitionId: string) {
    const skills = await many<{ skillId: string; name: string; minLevel: number }>(
      tx, `select rs.skill_id as "skillId", k.name::text as name, rs.min_level as "minLevel" from requisition_skills rs join skills k on k.id = rs.skill_id
            where rs.requisition_id = $1 order by rs.min_level desc, k.name`, [requisitionId],
    );
    if (!skills.length) return { skills, matches: [] as SkillMatch[] };
    const params: unknown[] = [skills.map((x) => x.skillId)];
    const scope = await this.authz.predicate('employees:read', EMPLOYEE_SCOPE, params, tx);
    const rows = await many<{ employeeId: string; name: string; title: string | null; departmentName: string | null; skillId: string; level: number }>(
      tx,
      `select e.id as "employeeId", trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as name, g.name as title, d.name as "departmentName",
              es.skill_id as "skillId", es.level
         from employee_skills es join employees e on e.id = es.employee_id
         left join departments d on d.id = e.current_department_id
         left join designations g on g.id = e.current_designation_id
        where es.skill_id = any($1::uuid[]) and e.status not in ('exited', 'pre_boarding') and ${scope}`,
      params,
    );
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
    return one<{ id: string; name: string; category: string | null }>(tx, `select id, name::text as name, category from skills where id = $1`, [id]);
  }

  /** Looking after the skill list is for people who may update every employee record. */
  private manager(s: Awaited<ReturnType<AuthzService['subject']>>) {
    return grantsFor(s, 'employees:update').some((g) => g.scope === 'tenant' && !Object.values(g.constraints ?? {}).some((v) => Array.isArray(v) && v.length));
  }

  private requireManager(s: Awaited<ReturnType<AuthzService['subject']>>) {
    if (!this.manager(s)) throw Errors.forbidden('Only people who look after every employee record can change the skill list');
  }
}
