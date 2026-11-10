import { type PlatformTx, type TenantTx, usersTable } from '../../platform/database/mongo.service';

/**
 * Display names for memberships (employee name, else the login's full name), with
 * each membership's status. Missing ids are left out.
 */
export async function membershipNames(tx: TenantTx | PlatformTx, ids: (string | null | undefined)[]): Promise<Map<string, { name: string; status: string }>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map();
  const ms = await tx.collection('memberships').find({ id: { $in: wanted } }, { projection: { user_id: 1, employee_id: 1, status: 1 } });
  const users = new Map((await (await usersTable(tx)).find({ id: { $in: ms.map((m) => m.user_id) } }, { projection: { full_name: 1 } })).map((u) => [u.id as string, u.full_name as string]));
  const employees = new Map(
    (await tx.collection('employees').find({ id: { $in: ms.map((m) => m.employee_id).filter(Boolean) } }, { projection: { preferred_name: 1, first_name: 1, last_name: 1 } })).map((e) => [e.id as string, e]),
  );
  return new Map(
    ms.map((m) => {
      const e = m.employee_id ? employees.get(m.employee_id) : undefined;
      const fromEmployee = e ? `${e.preferred_name ?? e.first_name ?? ''} ${e.last_name ?? ''}`.trim() : '';
      return [m.id as string, { name: fromEmployee || users.get(m.user_id) || '', status: m.status as string }];
    }),
  );
}

/** The name of an active workflow whose active version has a step pointing at this endpoint or connection, if any. */
export async function activeWorkflowUsing(tx: TenantTx, key: 'endpointId' | 'connectionId', id: string): Promise<string | null> {
  const flows = await tx.collection('workflows').find({ status: 'active', active_version_id: { $ne: null } }, { projection: { name: 1, active_version_id: 1 } });
  if (!flows.length) return null;
  const versions = await tx.collection('workflow_versions').find({ id: { $in: flows.map((f) => f.active_version_id) } }, { projection: { definition: 1 } });
  const using = new Set(versions.filter((v) => ((v.definition?.steps ?? []) as Record<string, unknown>[]).some((s) => s[key] === id)).map((v) => v.id as string));
  return (flows.find((f) => using.has(f.active_version_id))?.name as string | undefined) ?? null;
}
