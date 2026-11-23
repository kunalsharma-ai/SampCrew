import { randomUUID } from 'node:crypto';
import { Decimal128, type Db, type Document } from 'mongodb';
import type { MongoMigration } from '../migrator';

const dec = (v: unknown, fallback = '0') => {
  if (v === null || v === undefined) return fallback;
  const s = v instanceof Decimal128 ? v.toString() : String(v);
  const n = Number(s);
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : fallback;
};
const EMPTY_LISTS = { employmentTypes: [], departmentIds: [], designationIds: [], locationIds: [], legalEntityIds: [], groupIds: [], employeeIds: [] };

/** The approval rules a workspace had for leave (its approval chain), as leave type rules. */
async function approvalOf(db: Db, tenantId: unknown): Promise<Document> {
  const chain = await db.collection('approval_policies').findOne({ tenant_id: tenantId, resource_type: 'leave_request' } as never);
  const steps = ((chain?.steps as { type: string; role?: string }[] | undefined) ?? [{ type: 'manager' }]);
  const managerFirst = steps.some((s) => s.type === 'manager' || s.type === 'skip_level_manager');
  const roles = steps.filter((s) => s.type === 'role').map((s) => s.role ?? '');
  const hr = roles.some((r) => !/super|owner|org_admin/.test(r));
  const sup = roles.some((r) => /super|owner|org_admin/.test(r));
  return {
    routes: [hr && sup ? 'both' : sup ? 'super' : 'hr'], employeeChooses: false, order: 'sequential', managerFirst,
    hrWorkspaceId: null, superApproverMembershipId: null, superRequiredOverDays: null, escalation: { enabled: false, afterDays: 3 },
  };
}

/**
 * The leave rebuild. Leave types gain their policy, eligibility, approval rules, version and creator; who gets a type
 * becomes a separate allocation. Everything that worked before keeps working the same way:
 *  - each type takes the policy of its widest active policy (the one for everybody, else the first one);
 *  - each active policy becomes an allocation to the same people (its legal entity, department, designation and
 *    location), with its own entitlement when that differs from the type's;
 *  - each type is made available to the company's HR team and to every HR Workspace, whose admins approved their
 *    people's leave before;
 *  - the workspace's leave approval chain becomes the types' approval rules (a manager step stays a manager step);
 *  - the HR Workspace level loses leave:configure: only the Super Workspace creates and changes leave types now.
 * Requests, balances and the ledger are not changed. leave_policies stays as history and is no longer read.
 * Safe to run again: types that already have a version 1 snapshot are skipped.
 */
export const m0040LeaveRebuild: MongoMigration = {
  name: '0040_leave_rebuild',
  up: async (db) => {
    await db.collection('leave_requests').updateMany({ document_ids: { $exists: false } }, { $set: { document_ids: [] } });
    const types = await db.collection('leave_types').find({}).toArray();
    const approvals = new Map<string, Document>();
    for (const t of types) {
      if (await db.collection('leave_type_versions').findOne({ tenant_id: t.tenant_id, leave_type_id: t._id, version: 1 } as never)) continue;
      const key = String(t.tenant_id);
      if (!approvals.has(key)) approvals.set(key, await approvalOf(db, t.tenant_id));
      const policies = await db.collection('leave_policies').find({ tenant_id: t.tenant_id, leave_type_id: t._id, active: true } as never).toArray();
      const wide = policies.find((p) => !p.legal_entity_id && !p.department_id && !p.designation_id && !p.location_id) ?? policies[0];
      const policy = {
        accrualMethod: (wide?.accrual_method as string | undefined) ?? 'none',
        annualEntitlement: dec(wide?.annual_entitlement),
        rounding: (wide?.rounding as string | undefined) ?? 'half_day',
        allowNegativeBalance: Boolean(wide?.allow_negative_balance),
        minNoticeDays: Number(wide?.min_notice_days ?? 0),
        minDaysPerRequest: null,
        // The old limit counted leave days in one request, which is what maxDaysPerRequest means now.
        maxDaysPerRequest: wide?.max_consecutive_days ? dec(wide.max_consecutive_days) : null,
        maxConsecutiveDays: null,
        allowMultiDay: true,
        allowCustomDuration: true,
        availableDuringProbation: wide?.available_during_probation !== false,
        carryForwardMax: dec(wide?.carry_forward_max),
        carriedExpiryMonths: null,
        documents: { mode: 'none', requiredOverDays: null, note: '' },
      };
      const approval = approvals.get(key)!;
      const now = new Date();
      const set = {
        category: t.paid === false ? 'unpaid' : 'general',
        eligibility: EMPTY_LISTS,
        policy,
        approval,
        hr_allocatable: true,
        version: 1,
        created_by_level: 'system',
        created_by_name: 'SampCrew (carried over from the earlier leave settings)',
        updated_by_level: 'system',
        updated_by_name: 'SampCrew (carried over from the earlier leave settings)',
      };
      await db.collection('leave_types').updateOne({ _id: t._id }, { $set: set });
      await db.collection('leave_type_versions').insertOne({
        _id: randomUUID() as never, tenant_id: t.tenant_id, leave_type_id: t._id, version: 1, action: 'created', by_level: 'system',
        by_membership_id: null, by_name: set.created_by_name, changes: {}, note: 'Carried over from the leave settings before the rebuild',
        snapshot: { code: t.code, name: t.name, description: t.description ?? null, paid: t.paid, allowHalfDay: t.allow_half_day, kind: t.kind ?? 'standard', ...set },
        created_at: now,
      });
      const base = policy.annualEntitlement;
      for (const p of policies) {
        const scoped = Boolean(p.legal_entity_id || p.department_id || p.designation_id || p.location_id);
        const entitlement = dec(p.annual_entitlement);
        await db.collection('leave_allocations').insertOne({
          _id: randomUUID() as never, tenant_id: t.tenant_id, leave_type_id: t._id, target: 'employees', hr_workspace_id: null,
          criteria: {
            ...EMPTY_LISTS, all: !scoped,
            legalEntityIds: p.legal_entity_id ? [p.legal_entity_id] : [], departmentIds: p.department_id ? [p.department_id] : [],
            designationIds: p.designation_id ? [p.designation_id] : [], locationIds: p.location_id ? [p.location_id] : [],
          },
          entitlement_days: entitlement !== base ? Decimal128.fromString(Number(entitlement).toFixed(2)) : null,
          note: 'Carried over from a leave policy', by_level: 'system', by_membership_id: null, by_name: 'SampCrew', created_at: now, updated_at: now,
        });
      }
      const hrWorkspaces = await db.collection('hr_workspaces').find({ tenant_id: t.tenant_id, status: { $ne: 'archived' } } as never, { projection: { _id: 1 } }).toArray();
      for (const hw of [null, ...hrWorkspaces.map((h) => h._id)]) {
        await db.collection('leave_allocations').insertOne({
          _id: randomUUID() as never, tenant_id: t.tenant_id, leave_type_id: t._id, target: 'hr_workspace', hr_workspace_id: hw, criteria: {},
          entitlement_days: null, note: 'Carried over: this HR team approved its people\'s leave before', by_level: 'system', by_membership_id: null, by_name: 'SampCrew',
          created_at: now, updated_at: now,
        });
      }
    }
    // Only the Super Workspace configures leave now.
    const hrRoles = await db.collection('roles').find({ key: 'hr_workspace', is_system: true }, { projection: { _id: 1 } }).toArray();
    if (hrRoles.length) await db.collection('role_permissions').deleteMany({ role_id: { $in: hrRoles.map((r) => r._id) }, permission: 'leave:configure' });
  },
};
