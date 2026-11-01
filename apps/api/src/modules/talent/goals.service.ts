import { Injectable } from '@nestjs/common';
import { type CheckinInput, type GoalInput, talentMath } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { can, type Subject } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { EMPLOYEE_SCOPE } from '../employees/employee-attrs';
import { attrsOf, nameOf, needEmployee, type TalentEmployee, talentEmployee } from './talent-common';

interface GoalRow {
  id: string;
  employee_id: string;
  status: string;
  reported_progress: string;
}

interface KrRow {
  id: string;
  title: string;
  start_value: string;
  target_value: string;
  current_value: string;
}

const GOAL_COLS = `g.id, g.employee_id as "employeeId", ${nameOf('e')} as "employeeName", g.title, g.description,
  to_char(g.period_start, 'YYYY-MM-DD') as "periodStart", to_char(g.period_end, 'YYYY-MM-DD') as "periodEnd", g.weight, g.status,
  g.progress::float8 as progress, g.confidence, g.last_checkin_at as "lastCheckinAt", g.parent_goal_id as "parentGoalId",
  (select count(*)::int from goal_key_results k where k.goal_id = g.id) as "keyResultCount", g.updated_at as "updatedAt"`;

/**
 * Goals with measurable key results (OKR style). People set and update their own goals; managers do the same for
 * people in their `performance:manage` scope. Progress is computed from key results (see talent-math) and every
 * update is kept as a check-in.
 */
@Injectable()
export class GoalsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  /** Who may change this person's goals: the person themselves, or a manager or HR with `performance:manage`. */
  private canManage(s: Subject, e: TalentEmployee) {
    return s.employeeId === e.id || can(s, 'performance:manage', attrsOf(e)).allowed;
  }

  private async readable(tx: Tx, e: TalentEmployee) {
    const s = await this.authz.subject(tx);
    if (s.employeeId === e.id) return s;
    if (can(s, 'performance:read', attrsOf(e)).allowed || can(s, 'performance:manage', attrsOf(e)).allowed) return s;
    throw Errors.notFound('Goal');
  }

  private async load(tx: Tx, id: string, lock = false) {
    const g = await one<GoalRow>(tx, `select id, employee_id, status, reported_progress::text from goals where id = $1${lock ? ' for update' : ''}`, [id]);
    if (!g) throw Errors.notFound('Goal');
    return g;
  }

  private async writable(tx: Tx, g: GoalRow) {
    const e = await talentEmployee(tx, g.employee_id);
    const s = await this.readable(tx, e);
    if (!this.canManage(s, e)) throw Errors.forbidden('Only the goal owner or their manager can change this goal');
    return { s, e };
  }

  async list(q: { view: 'mine' | 'team'; employeeId?: string; status?: string }) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      if (q.view === 'mine' || q.employeeId) {
        const employeeId = q.employeeId ?? s.employeeId;
        if (!employeeId) return { goals: [], overallProgress: 0 };
        if (employeeId !== s.employeeId) await this.readable(tx, await talentEmployee(tx, employeeId));
        const goals = await many<{ progress: number; weight: number; status: string }>(
          tx,
          `select ${GOAL_COLS} from goals g join employees e on e.id = g.employee_id
            where g.employee_id = $1 and ($2::text is null or g.status = $2) order by g.status = 'active' desc, g.period_end desc, g.created_at`,
          [employeeId, q.status ?? null],
        );
        return { goals, overallProgress: talentMath.weightedProgress(goals.filter((g) => g.status !== 'cancelled')) };
      }
      const params: unknown[] = [q.status ?? null, s.employeeId ?? null];
      const pred = await this.authz.predicate('performance:manage', EMPLOYEE_SCOPE, params, tx);
      const goals = await many(
        tx,
        `select ${GOAL_COLS} from goals g join employees e on e.id = g.employee_id
          where ${pred} and e.id is distinct from $2 and ($1::text is null or g.status = $1)
          order by ${nameOf('e')}, g.period_end desc limit 500`,
        params,
      );
      return { goals, overallProgress: null };
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const g = await this.load(tx, id);
      const e = await talentEmployee(tx, g.employee_id);
      const s = await this.readable(tx, e);
      const goal = await one<Record<string, unknown>>(tx, `select ${GOAL_COLS} from goals g join employees e on e.id = g.employee_id where g.id = $1`, [id]);
      const keyResults = await many<KrRow & { unit: string; position: number }>(
        tx, `select id, title, start_value::text as "startValue", target_value::text as "targetValue", current_value::text as "currentValue", unit, position
               from goal_key_results where goal_id = $1 order by position`, [id],
      );
      const checkins = await many(
        tx,
        `select c.id, c.progress::float8 as progress, c.confidence, c.note, c.values, c.created_at as "createdAt", u.full_name as "byName"
           from goal_checkins c join memberships m on m.id = c.by_membership_id join users u on u.id = m.user_id
          where c.goal_id = $1 order by c.created_at desc limit 100`,
        [id],
      );
      // The parent's title is shown so people can see what their goal supports, even when they cannot open it.
      const parent = goal?.parentGoalId
        ? await one(tx, `select g.id, g.title, ${nameOf('e')} as "employeeName" from goals g join employees e on e.id = g.employee_id where g.id = $1`, [goal.parentGoalId])
        : null;
      const children = await many(tx, `select g.id, g.title, g.progress::float8 as progress, g.status, ${nameOf('e')} as "employeeName"
                                         from goals g join employees e on e.id = g.employee_id where g.parent_goal_id = $1 order by g.created_at`, [id]);
      return {
        ...goal,
        keyResults: keyResults.map((k) => ({ ...k, progress: talentMath.keyResultProgress((k as any).startValue, (k as any).targetValue, (k as any).currentValue) })),
        checkins,
        parent,
        children,
        can: { manage: this.canManage(s, e) && g.status === 'active', reopen: this.canManage(s, e) && g.status !== 'active' },
      };
    });
  }

  /** Goals a new goal can support: active goals of the owner's managers (up to five levels) and of the owner. */
  async alignable(employeeId?: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const owner = await talentEmployee(tx, employeeId ?? needEmployee(s.employeeId));
      await this.readable(tx, owner);
      return many(
        tx,
        `with recursive chain(id, depth) as (
           select current_manager_employee_id, 1 from employees where id = $1 and current_manager_employee_id is not null
           union all
           select e.current_manager_employee_id, c.depth + 1 from employees e join chain c on e.id = c.id where e.current_manager_employee_id is not null and c.depth < 5
         )
         select g.id, g.title, ${nameOf('e')} as "employeeName", to_char(g.period_end, 'YYYY-MM-DD') as "periodEnd"
           from goals g join employees e on e.id = g.employee_id
          where g.status = 'active' and (g.employee_id in (select id from chain) or g.employee_id = $1)
          order by g.employee_id = $1, g.period_end desc limit 100`,
        [owner.id],
      );
    });
  }

  private async checkParent(tx: Tx, parentId: string | null | undefined, ownerId: string, selfId?: string) {
    if (!parentId) return null;
    if (parentId === selfId) throw Errors.badRequest('invalid_parent', 'A goal cannot support itself');
    const options = await this.alignableIds(tx, ownerId);
    if (!options.has(parentId)) throw Errors.badRequest('invalid_parent', "Align the goal with one of your own or your managers' active goals");
    if (selfId) {
      // No cycles: the parent may not be one of this goal's descendants.
      const loop = await one(tx, `with recursive d(id) as (select id from goals where parent_goal_id = $1 union select g.id from goals g join d on g.parent_goal_id = d.id)
                                  select 1 from d where id = $2`, [selfId, parentId]);
      if (loop) throw Errors.badRequest('invalid_parent', 'That goal already supports this one');
    }
    return parentId;
  }

  private async alignableIds(tx: Tx, ownerId: string) {
    const rows = await many<{ id: string }>(
      tx,
      `with recursive chain(id, depth) as (
         select current_manager_employee_id, 1 from employees where id = $1 and current_manager_employee_id is not null
         union all
         select e.current_manager_employee_id, c.depth + 1 from employees e join chain c on e.id = c.id where e.current_manager_employee_id is not null and c.depth < 5
       ) select g.id from goals g where g.status = 'active' and (g.employee_id in (select id from chain) or g.employee_id = $1)`,
      [ownerId],
    );
    return new Set(rows.map((r) => r.id));
  }

  private async recompute(tx: Tx, goalId: string) {
    const g = (await one<{ reported_progress: string }>(tx, 'select reported_progress::text from goals where id = $1', [goalId]))!;
    const krs = await many<KrRow>(tx, 'select id, title, start_value::text, target_value::text, current_value::text from goal_key_results where goal_id = $1', [goalId]);
    const progress = talentMath.goalProgress(krs.map((k) => ({ start: k.start_value, target: k.target_value, current: k.current_value })), Number(g.reported_progress));
    await tx.query('update goals set progress = $2 where id = $1', [goalId, progress]);
    return progress;
  }

  async create(input: GoalInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const owner = await talentEmployee(tx, input.employeeId ?? needEmployee(s.employeeId));
      await this.readable(tx, owner);
      if (!this.canManage(s, owner)) throw Errors.forbidden('You can set goals for yourself, or for people you manage');
      if (owner.status === 'exited') throw Errors.badRequest('employee_exited', 'This person has left');
      const parent = await this.checkParent(tx, input.parentGoalId, owner.id);
      const g = (await one<{ id: string }>(
        tx,
        `insert into goals (tenant_id, employee_id, parent_goal_id, title, description, period_start, period_end, weight, created_by_membership_id)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [owner.id, parent, input.title, input.description, input.periodStart, input.periodEnd, input.weight, actor.membershipId],
      ))!;
      await this.writeKeyResults(tx, g.id, input.keyResults);
      await this.recompute(tx, g.id);
      await this.audit.record(tx, { action: 'goal.created', resourceType: 'goal', resourceId: g.id, changes: input });
      if (owner.id !== s.employeeId) {
        await this.notifications.notify(tx, { membershipIds: [owner.membership_id], kind: 'goal.assigned', title: `New goal for you: ${input.title}`, link: `/goals/${g.id}` });
      }
      return { id: g.id };
    });
  }

  private async writeKeyResults(tx: Tx, goalId: string, krs: GoalInput['keyResults']) {
    const existing = await many<{ id: string }>(tx, 'select id from goal_key_results where goal_id = $1', [goalId]);
    const keep = new Set(krs.map((k) => k.id).filter(Boolean));
    for (const k of krs) if (k.id && !existing.some((e) => e.id === k.id)) throw Errors.badRequest('unknown_key_result', 'A key result does not belong to this goal');
    await tx.query('delete from goal_key_results where goal_id = $1 and not (id = any($2::uuid[]))', [goalId, [...keep]]);
    for (const [i, k] of krs.entries()) {
      if (k.id) {
        await tx.query('update goal_key_results set title = $2, start_value = $3, target_value = $4, unit = $5, position = $6 where id = $1', [k.id, k.title, k.startValue, k.targetValue, k.unit, i + 1]);
      } else {
        await tx.query(
          `insert into goal_key_results (tenant_id, goal_id, position, title, start_value, target_value, current_value, unit) values (app_tenant_id(), $1, $2, $3, $4, $5, $4, $6)`,
          [goalId, i + 1, k.title, k.startValue, k.targetValue, k.unit],
        );
      }
    }
  }

  async update(id: string, input: GoalInput) {
    return this.db.tenant(async (tx) => {
      const g = await this.load(tx, id, true);
      const { e } = await this.writable(tx, g);
      if (g.status !== 'active') throw Errors.conflict('invalid_state', `This goal is ${g.status}. Reopen it to change it.`);
      if (input.employeeId && input.employeeId !== g.employee_id) throw Errors.badRequest('owner_fixed', 'A goal cannot move to another person');
      const parent = await this.checkParent(tx, input.parentGoalId, e.id, id);
      await tx.query(
        `update goals set parent_goal_id = $2, title = $3, description = $4, period_start = $5, period_end = $6, weight = $7 where id = $1`,
        [id, parent, input.title, input.description, input.periodStart, input.periodEnd, input.weight],
      );
      await this.writeKeyResults(tx, id, input.keyResults);
      await this.recompute(tx, id);
      await this.audit.record(tx, { action: 'goal.updated', resourceType: 'goal', resourceId: id, changes: input });
      return { id };
    });
  }

  async checkin(id: string, input: CheckinInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const g = await this.load(tx, id, true);
      const { s, e } = await this.writable(tx, g);
      if (g.status !== 'active') throw Errors.conflict('invalid_state', `This goal is ${g.status}`);
      const krs = await many<KrRow>(tx, 'select id, title, start_value::text, target_value::text, current_value::text from goal_key_results where goal_id = $1', [id]);
      if (krs.length && input.progress !== undefined) throw Errors.badRequest('progress_from_key_results', 'Progress comes from the key results. Update their values instead.');
      if (!krs.length && input.progress === undefined) throw Errors.badRequest('progress_required', 'Enter the progress so far');
      if (krs.length && !input.values.length) throw Errors.badRequest('values_required', 'Update at least one key result');
      const changes: { keyResultId: string; title: string; from: string; to: string }[] = [];
      for (const v of input.values) {
        const kr = krs.find((k) => k.id === v.keyResultId);
        if (!kr) throw Errors.badRequest('unknown_key_result', 'A key result does not belong to this goal');
        await tx.query('update goal_key_results set current_value = $2 where id = $1', [kr.id, v.value]);
        changes.push({ keyResultId: kr.id, title: kr.title, from: kr.current_value, to: v.value });
      }
      if (input.progress !== undefined) await tx.query('update goals set reported_progress = $2 where id = $1', [id, input.progress]);
      const progress = await this.recompute(tx, id);
      await tx.query('update goals set confidence = $2, last_checkin_at = now() where id = $1', [id, input.confidence]);
      await tx.query(
        `insert into goal_checkins (tenant_id, goal_id, progress, confidence, note, values, by_membership_id) values (app_tenant_id(), $1, $2, $3, $4, $5, $6)`,
        [id, progress, input.confidence, input.note, JSON.stringify(changes), actor.membershipId],
      );
      await this.audit.record(tx, { action: 'goal.checked_in', resourceType: 'goal', resourceId: id, metadata: { progress, confidence: input.confidence } });
      // Tell the manager when the owner flags a risk.
      if (s.employeeId === e.id && input.confidence !== 'on_track' && e.manager_membership_id) {
        const title = (await one<{ title: string }>(tx, 'select title from goals where id = $1', [id]))!.title;
        await this.notifications.notify(tx, {
          membershipIds: [e.manager_membership_id], kind: 'goal.at_risk',
          title: `${e.name} marked "${title}" as ${input.confidence === 'at_risk' ? 'at risk' : 'off track'}`, link: `/goals/${id}`,
        });
      }
      return { progress };
    });
  }

  async setStatus(id: string, status: 'active' | 'completed' | 'cancelled', note: string) {
    return this.db.tenant(async (tx) => {
      const g = await this.load(tx, id, true);
      await this.writable(tx, g);
      if (g.status === status) return { status };
      await tx.query('update goals set status = $2 where id = $1', [id, status]);
      await this.audit.record(tx, { action: `goal.${status === 'active' ? 'reopened' : status}`, resourceType: 'goal', resourceId: id, metadata: { note } });
      return { status };
    });
  }

  async remove(id: string) {
    return this.db.tenant(async (tx) => {
      const g = await this.load(tx, id, true);
      await this.writable(tx, g);
      const used = await one(tx, 'select 1 from goal_checkins where goal_id = $1 union all select 1 from goals where parent_goal_id = $1 limit 1', [id]);
      if (used) throw Errors.conflict('goal_in_use', 'This goal has check-ins or supporting goals. Cancel it instead, so its history is kept.');
      await tx.query('delete from goals where id = $1', [id]);
      await this.audit.record(tx, { action: 'goal.deleted', resourceType: 'goal', resourceId: id });
    });
  }
}
