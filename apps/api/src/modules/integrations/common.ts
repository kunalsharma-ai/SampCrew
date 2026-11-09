import { type PlatformTx, type TenantTx, usersTable } from '../../platform/database/mongo.service';

/** Display name for a membership (employee name, else the login's full name). Needs m, u, e aliases. */
export const WHO = (u: string, e: string) => `coalesce(nullif(trim(coalesce(${e}.preferred_name, ${e}.first_name) || ' ' || ${e}.last_name), ''), ${u}.full_name)`;
export const BY = (col: string, alias: string) =>
  `left join memberships ${alias}m on ${alias}m.id = ${col} left join users ${alias}u on ${alias}u.id = ${alias}m.user_id left join employees ${alias}e on ${alias}e.id = ${alias}m.employee_id`;

/**
 * The MongoDB form of WHO/BY: display names for memberships (employee name, else the login's full name), with
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
