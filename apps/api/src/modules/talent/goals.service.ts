import { Injectable } from '@nestjs/common';
import { type CheckinInput, type GoalInput, talentMath } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { can, type Subject } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { membershipUserNames, MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { EMPLOYEE_FIELDS } from '../employees/employee-attrs';
import { employeeNames } from '../employees/employee-view';
import { attrsOf, needEmployee, type TalentEmployee, talentEmployee } from './talent-common';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

/** Goals as the API returns them (the SQL GOAL_COLS), in the order given. */
async function goalViews(tx: TenantTx, goals: Doc[]) {
  if (!goals.length) return [];
  const names = await employeeNames(tx, goals.map((g) => g.employee_id));
  const krs = await tx.collection('goal_key_results').find({ goal_id: { $in: goals.map((g) => g.id) } }, { projection: { goal_id: 1 } });
  return goals.map((g) => ({
    id: g.id as string, employeeId: g.employee_id as string, employeeName: names.get(g.employee_id)?.name ?? '', title: g.title as string, description: g.description,
    periodStart: g.period_start as string, periodEnd: g.period_end as string, weight: g.weight as number, status: g.status as string,
    progress: Number(g.progress), confidence: g.confidence ?? null, lastCheckinAt: g.last_checkin_at ?? null, parentGoalId: (g.parent_goal_id as string | null) ?? null,
    keyResultCount: krs.filter((k) => k.goal_id === g.id).length, updatedAt: g.updated_at,
  }));
}

/** Up to five levels of an employee's managers (their employee ids). */
async function managerChain(tx: TenantTx, employeeId: string) {
  const chain: string[] = [];
  let current = (await tx.collection('employees').findOne({ id: employeeId }, { projection: { current_manager_employee_id: 1 } }))?.current_manager_employee_id as string | null | undefined;
  while (current && chain.length < 5 && !chain.includes(current)) {
    chain.push(current);
    current = (await tx.collection('employees').findOne({ id: current }, { projection: { current_manager_employee_id: 1 } }))?.current_manager_employee_id;
  }
  return chain;
}

const byKey = <T>(key: (x: T) => Array<string | number | boolean>) => (a: T, b: T) => {
  const x = key(a), y = key(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
};

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

  private async readable(tx: TenantTx, e: TalentEmployee) {
    const s = await this.authz.subject(tx);
    if (s.employeeId === e.id) return s;
    if (can(s, 'performance:read', attrsOf(e)).allowed || can(s, 'performance:manage', attrsOf(e)).allowed) return s;
    throw Errors.notFound('Goal');
  }

  private async load(tx: TenantTx, id: string, lock = false): Promise<GoalRow> {
    const goals = tx.collection('goals');
    if (lock) await goals.lock({ id });
    const g = await goals.findOne({ id }, { projection: { employee_id: 1, status: 1, reported_progress: 1 } });
    if (!g) throw Errors.notFound('Goal');
    return { id: g.id, employee_id: g.employee_id, status: g.status, reported_progress: g.reported_progress };
  }

  private async writable(tx: TenantTx, g: GoalRow) {
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
        const docs = await tx.collection('goals').find({ employee_id: employeeId, ...(q.status ? { status: q.status } : {}) });
        docs.sort(byKey((g: Doc) => [g.status === 'active' ? 0 : 1, -new Date(g.period_end).getTime(), new Date(g.created_at).getTime()]));
        const goals = await goalViews(tx, docs);
        return { goals, overallProgress: talentMath.weightedProgress(goals.filter((g) => g.status !== 'cancelled')) };
      }
      const people = (await tx.collection('employees').distinct<string>('id', await this.authz.filter('performance:manage', EMPLOYEE_FIELDS, tx))).filter((id) => id !== s.employeeId);
      const docs = await tx.collection('goals').find({ employee_id: { $in: people }, ...(q.status ? { status: q.status } : {}) });
      const goals = await goalViews(tx, docs);
      goals.sort(byKey((g) => [g.employeeName, -new Date(g.periodEnd).getTime()]));
      return { goals: goals.slice(0, 500), overallProgress: null };
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const g = await this.load(tx, id);
      const e = await talentEmployee(tx, g.employee_id);
      const s = await this.readable(tx, e);
      const [goal] = await goalViews(tx, [(await tx.collection('goals').findOne({ id }))!]);
      const keyResults = (await tx.collection('goal_key_results').find({ goal_id: id }, { sort: { position: 1 } })).map((k) => ({
        id: k.id as string, title: k.title as string, startValue: k.start_value as string, targetValue: k.target_value as string, currentValue: k.current_value as string,
        unit: k.unit as string, position: k.position as number,
      }));
      const checkinDocs = await tx.collection('goal_checkins').find({ goal_id: id }, { sort: { created_at: -1 }, limit: 100 });
      const by = await membershipUserNames(tx, checkinDocs.map((c) => c.by_membership_id));
      const checkins = checkinDocs
        .filter((c) => by.has(c.by_membership_id))
        .map((c) => ({ id: c.id, progress: Number(c.progress), confidence: c.confidence, note: c.note, values: c.values, createdAt: c.created_at, byName: by.get(c.by_membership_id) ?? null }));
      // The parent's title is shown so people can see what their goal supports, even when they cannot open it.
      const parentDoc = goal?.parentGoalId ? await tx.collection('goals').findOne({ id: goal.parentGoalId }) : undefined;
      const childDocs = await tx.collection('goals').find({ parent_goal_id: id }, { sort: { created_at: 1 } });
      const names = await employeeNames(tx, [parentDoc?.employee_id, ...childDocs.map((c) => c.employee_id)]);
      const parent = parentDoc ? { id: parentDoc.id, title: parentDoc.title, employeeName: names.get(parentDoc.employee_id)?.name ?? '' } : null;
      const children = childDocs.map((c) => ({ id: c.id, title: c.title, progress: Number(c.progress), status: c.status, employeeName: names.get(c.employee_id)?.name ?? '' }));
      return {
        ...goal,
        keyResults: keyResults.map((k) => ({ ...k, progress: talentMath.keyResultProgress(k.startValue, k.targetValue, k.currentValue) })),
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
      const chain = await managerChain(tx, owner.id);
      const goals = await tx.collection('goals').find({ status: 'active', employee_id: { $in: [...chain, owner.id] } });
      const names = await employeeNames(tx, goals.map((g) => g.employee_id));
      goals.sort(byKey((g: Doc) => [g.employee_id === owner.id ? 1 : 0, -new Date(g.period_end).getTime()]));
      return goals.slice(0, 100).map((g) => ({ id: g.id, title: g.title, employeeName: names.get(g.employee_id)?.name ?? '', periodEnd: g.period_end }));
    });
  }

  private async checkParent(tx: TenantTx, parentId: string | null | undefined, ownerId: string, selfId?: string) {
    if (!parentId) return null;
    if (parentId === selfId) throw Errors.badRequest('invalid_parent', 'A goal cannot support itself');
    const options = await this.alignableIds(tx, ownerId);
    if (!options.has(parentId)) throw Errors.badRequest('invalid_parent', "Align the goal with one of your own or your managers' active goals");
    if (selfId) {
      // No cycles: the parent may not be one of this goal's descendants.
      const seen = new Set<string>();
      let frontier = [selfId];
      while (frontier.length) {
        frontier = (await tx.collection('goals').distinct<string>('id', { parent_goal_id: { $in: frontier } })).filter((x) => !seen.has(x));
        for (const x of frontier) seen.add(x);
      }
      if (seen.has(parentId)) throw Errors.badRequest('invalid_parent', 'That goal already supports this one');
    }
    return parentId;
  }

  private async alignableIds(tx: TenantTx, ownerId: string) {
    const chain = await managerChain(tx, ownerId);
    return new Set(await tx.collection('goals').distinct<string>('id', { status: 'active', employee_id: { $in: [...chain, ownerId] } }));
  }

  private async recompute(tx: TenantTx, goalId: string) {
    const g = (await tx.collection('goals').findOne({ id: goalId }, { projection: { reported_progress: 1 } }))!;
    const krs = await tx.collection('goal_key_results').find({ goal_id: goalId });
    const progress = talentMath.goalProgress(krs.map((k) => ({ start: k.start_value, target: k.target_value, current: k.current_value })), Number(g.reported_progress));
    await tx.collection('goals').updateOne({ id: goalId }, { $set: { progress } });
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
      const g = await tx.collection('goals').insert({
        employee_id: owner.id, parent_goal_id: parent, title: input.title, description: input.description, period_start: input.periodStart, period_end: input.periodEnd,
        weight: input.weight, created_by_membership_id: actor.membershipId,
      });
      await this.writeKeyResults(tx, g.id, input.keyResults);
      await this.recompute(tx, g.id);
      await this.audit.record(tx, { action: 'goal.created', resourceType: 'goal', resourceId: g.id, changes: input });
      if (owner.id !== s.employeeId) {
        await this.notifications.notify(tx, { membershipIds: [owner.membership_id], kind: 'goal.assigned', title: `New goal for you: ${input.title}`, link: `/goals/${g.id}` });
      }
      return { id: g.id as string };
    });
  }

  private async writeKeyResults(tx: TenantTx, goalId: string, krs: GoalInput['keyResults']) {
    const table = tx.collection('goal_key_results');
    const existing = await table.distinct<string>('id', { goal_id: goalId });
    const keep = krs.map((k) => k.id).filter((x): x is string => !!x);
    for (const id of keep) if (!existing.includes(id)) throw Errors.badRequest('unknown_key_result', 'A key result does not belong to this goal');
    await table.delete({ goal_id: goalId, id: { $nin: keep } });
    for (const [i, k] of krs.entries()) {
      if (k.id) {
        await table.updateOne({ id: k.id }, { $set: { title: k.title, start_value: k.startValue, target_value: k.targetValue, unit: k.unit, position: i + 1 } });
      } else {
        await table.insert({ goal_id: goalId, position: i + 1, title: k.title, start_value: k.startValue, target_value: k.targetValue, current_value: k.startValue, unit: k.unit });
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
      await tx.collection('goals').updateOne({ id }, {
        $set: { parent_goal_id: parent, title: input.title, description: input.description, period_start: input.periodStart, period_end: input.periodEnd, weight: input.weight },
      });
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
      const krs = (await tx.collection('goal_key_results').find({ goal_id: id })) as unknown as KrRow[];
      if (krs.length && input.progress !== undefined) throw Errors.badRequest('progress_from_key_results', 'Progress comes from the key results. Update their values instead.');
      if (!krs.length && input.progress === undefined) throw Errors.badRequest('progress_required', 'Enter the progress so far');
      if (krs.length && !input.values.length) throw Errors.badRequest('values_required', 'Update at least one key result');
      const changes: { keyResultId: string; title: string; from: string; to: string }[] = [];
      for (const v of input.values) {
        const kr = krs.find((k) => k.id === v.keyResultId);
        if (!kr) throw Errors.badRequest('unknown_key_result', 'A key result does not belong to this goal');
        await tx.collection('goal_key_results').updateOne({ id: kr.id }, { $set: { current_value: v.value } });
        changes.push({ keyResultId: kr.id, title: kr.title, from: kr.current_value, to: v.value });
      }
      if (input.progress !== undefined) await tx.collection('goals').updateOne({ id }, { $set: { reported_progress: input.progress } });
      const progress = await this.recompute(tx, id);
      await tx.collection('goals').updateOne({ id }, { $set: { confidence: input.confidence, last_checkin_at: new Date() } });
      await tx.collection('goal_checkins').insert({ goal_id: id, progress, confidence: input.confidence, note: input.note, values: changes, by_membership_id: actor.membershipId });
      await this.audit.record(tx, { action: 'goal.checked_in', resourceType: 'goal', resourceId: id, metadata: { progress, confidence: input.confidence } });
      // Tell the manager when the owner flags a risk.
      if (s.employeeId === e.id && input.confidence !== 'on_track' && e.manager_membership_id) {
        const title = (await tx.collection('goals').findOne({ id }, { projection: { title: 1 } }))!.title as string;
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
      await tx.collection('goals').updateOne({ id }, { $set: { status } });
      await this.audit.record(tx, { action: `goal.${status === 'active' ? 'reopened' : status}`, resourceType: 'goal', resourceId: id, metadata: { note } });
      return { status };
    });
  }

  async remove(id: string) {
    return this.db.tenant(async (tx) => {
      const g = await this.load(tx, id, true);
      await this.writable(tx, g);
      const used = (await tx.collection('goal_checkins').exists({ goal_id: id })) || (await tx.collection('goals').exists({ parent_goal_id: id }));
      if (used) throw Errors.conflict('goal_in_use', 'This goal has check-ins or supporting goals. Cancel it instead, so its history is kept.');
      await tx.collection('goals').deleteOne({ id });
      await this.audit.record(tx, { action: 'goal.deleted', resourceType: 'goal', resourceId: id });
    });
  }
}
