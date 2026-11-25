import { PAGE_ACCESS_CHOICES, isFeaturePart, withheldPages, type PageAccessKey } from '@crew/contracts';
import type { TenantTx } from '../../platform/database/mongo.service';

/**
 * Page access for one person (issue #86): the everyday pages (PAGE_ACCESS_CHOICES) left unticked are kept as withheld
 * pages in member_module_assignments, next to any modules their HR Workspace withholds (those are not touched).
 * Nothing is stored for someone without a login. Returns false when there is no login.
 */
export async function setPageAccess(tx: TenantTx, employeeId: string, given: readonly string[], by: string): Promise<boolean> {
  const e = await tx.collection('employees').findOne({ id: employeeId }, { projection: { membership_id: 1 } });
  if (!e?.membership_id) return false;
  const pages = withheldPages(given);
  const current = await tx.collection('member_module_assignments').findOne({ membership_id: e.membership_id });
  if (current) {
    const keep = ((current.withheld_features ?? []) as string[]).filter((k) => !isFeaturePart(k));
    await tx.collection('member_module_assignments').updateOne({ id: current.id }, { $set: { withheld_features: [...keep, ...pages].sort(), updated_by_membership_id: by } });
  } else if (pages.length) {
    await tx.collection('member_module_assignments').insert({ membership_id: e.membership_id, withheld_features: pages, version: 1, updated_by_membership_id: by });
  }
  return true;
}

/** The choices currently on for a person (all of a choice's pages given), or null without a login. */
export async function pageAccessOf(tx: TenantTx, employeeId: string): Promise<PageAccessKey[] | null> {
  const e = await tx.collection('employees').findOne({ id: employeeId }, { projection: { membership_id: 1 } });
  if (!e?.membership_id) return null;
  const a = await tx.collection('member_module_assignments').findOne({ membership_id: e.membership_id }, { projection: { withheld_features: 1 } });
  const withheld = new Set((a?.withheld_features ?? []) as string[]);
  return PAGE_ACCESS_CHOICES.filter((c) => c.parts.every((k) => !withheld.has(k))).map((c) => c.key);
}
