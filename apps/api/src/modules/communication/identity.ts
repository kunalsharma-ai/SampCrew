import { senderIdentity, type SenderIdentity, type SenderLevel } from '@crew/contracts';
import type { PlatformTx, TenantTx } from '../../platform/database/mongo.service';
import { memberNames } from '../employees/employee-view';

export interface MemberIdentity extends SenderIdentity {
  level: Exclude<SenderLevel, 'console'>;
  email: string | null;
  employeeCode: string | null;
}

const uniq = (ids: unknown[]) => [...new Set(ids.filter((x): x is string => typeof x === 'string' && !!x))];

/**
 * Who each member is for the chat: name, access level (Super, HR or Employee Workspace, the highest held) and the
 * workspace they belong to. Super Workspace and company-wide HR belong to the company; an HR Workspace admin to the
 * HR Workspaces they run; an employee to their HR Workspace, or the company when they are in the central group.
 */
export async function memberIdentities(tx: TenantTx, membershipIds: unknown[]): Promise<Map<string, MemberIdentity>> {
  const ids = uniq(membershipIds);
  if (!ids.length) return new Map();
  const [names, memberships, tenant] = await Promise.all([
    memberNames(tx, ids),
    tx.collection('memberships').find({ id: { $in: ids } }, { projection: { user_id: 1, employee_id: 1 } }),
    tx.collection('tenants').findOne({}, { projection: { name: 1 } }),
  ]);
  const company = (tenant?.name as string | undefined) ?? null;
  const roles = new Map((await tx.collection('roles').find({ is_system: true, key: { $in: ['super_workspace', 'hr_workspace'] } }, { projection: { key: 1 } })).map((r) => [r.id as string, r.key as string]));
  const assignments = await tx.collection('role_assignments').find({ membership_id: { $in: ids }, role_id: { $in: [...roles.keys()] } }, { projection: { membership_id: 1, role_id: 1, constraints: 1 } });
  const employees = await tx.collection('employees').find({ membership_id: { $in: ids } }, { projection: { membership_id: 1, employee_code: 1, hr_workspace_id: 1, work_email: 1 } });
  const empOf = new Map(employees.map((e) => [e.membership_id as string, e]));
  const users = new Map((await (await tx.users()).find({ id: { $in: memberships.map((m) => m.user_id) } }, { projection: { email: 1 } })).map((u) => [u.id as string, (u.email as string | null) ?? null]));
  const spaceIds = uniq([
    ...assignments.flatMap((a) => ((a.constraints?.hrWorkspaceIds as string[] | undefined) ?? [])),
    ...employees.map((e) => e.hr_workspace_id),
  ]);
  const spaces = new Map((spaceIds.length ? await tx.collection('hr_workspaces').find({ id: { $in: spaceIds } }, { projection: { name: 1 } }) : []).map((w) => [w.id as string, w.name as string]));
  const out = new Map<string, MemberIdentity>();
  for (const m of memberships) {
    const mine = assignments.filter((a) => a.membership_id === m.id);
    const emp = empOf.get(m.id as string);
    let level: MemberIdentity['level'] = 'employee';
    let workspace: string | null = (emp?.hr_workspace_id && spaces.get(emp.hr_workspace_id)) || company;
    if (mine.some((a) => roles.get(a.role_id) === 'super_workspace')) {
      level = 'super';
      workspace = company;
    } else {
      const hr = mine.filter((a) => roles.get(a.role_id) === 'hr_workspace');
      if (hr.length) {
        level = 'hr';
        const named = hr.flatMap((a) => ((a.constraints?.hrWorkspaceIds as string[] | undefined) ?? []));
        // A grant with no HR Workspace named covers the whole company.
        workspace = hr.some((a) => !((a.constraints?.hrWorkspaceIds as string[] | undefined) ?? []).length) || !named.length
          ? company
          : uniq(named).map((w) => spaces.get(w)).filter(Boolean).join(', ') || company;
      }
    }
    const name = names.get(m.id as string) ?? 'Unnamed';
    out.set(m.id as string, {
      ...senderIdentity(name, level, workspace),
      level,
      email: (emp?.work_email as string | undefined) ?? users.get(m.user_id as string) ?? null,
      employeeCode: (emp?.employee_code as string | undefined) ?? null,
    });
  }
  return out;
}

/** The identity to show for a stored message: what was recorded when it was sent, else the sender's current one. */
export function storedIdentity(row: { sender_level?: string | null; sender_workspace?: string | null }, name: string | null, current: MemberIdentity | undefined): SenderIdentity | null {
  if (!name && !current) return null;
  if (row.sender_level) return senderIdentity(name ?? current?.name ?? 'Unnamed', row.sender_level as SenderLevel, row.sender_workspace ?? null);
  return current ? senderIdentity(name ?? current.name, current.level, current.workspace) : null;
}

/** Whether a member is on the Super Workspace level (the only tenant level that may use SampCrew Support). */
export async function isSuperWorkspace(tx: TenantTx, membershipId: string): Promise<boolean> {
  const role = await tx.collection('roles').findOne({ is_system: true, key: 'super_workspace' }, { projection: { _id: 1 } });
  if (!role) return false;
  return tx.collection('role_assignments').exists({ membership_id: membershipId, role_id: role.id });
}

/** Active Super Workspace members of the tenant: who hears about Console Admin replies. */
export async function superWorkspaceMembers(tx: TenantTx | PlatformTx, tenantId?: string): Promise<string[]> {
  const t = tenantId ? { tenant_id: tenantId } : {};
  const role = await tx.collection('roles').findOne({ ...t, is_system: true, key: 'super_workspace' }, { projection: { _id: 1 } });
  if (!role) return [];
  const ids = await tx.collection('role_assignments').distinct<string>('membership_id', { ...t, role_id: role.id });
  if (!ids.length) return [];
  return tx.collection('memberships').distinct<string>('id', { ...t, id: { $in: ids }, status: 'active' });
}
