import type { AudienceInput } from '@crew/contracts';
import sanitizeHtml from 'sanitize-html';
import type { TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

/** Employees who are still with the company. */
export const CURRENT_STATUSES = ['active', 'notice', 'probation'];

export interface AudienceMember { membershipId: string; employeeId: string | null }

/** Every department id in each department's subtree (the department and everything under it). */
async function departmentSubtrees(tx: TenantTx, roots: string[]): Promise<Set<string>> {
  if (!roots.length) return new Set();
  const departments = await tx.collection('departments').find({}, { projection: { parent_id: 1 } });
  const children = new Map<string, string[]>();
  for (const d of departments) if (d.parent_id) children.set(d.parent_id, [...(children.get(d.parent_id) ?? []), d.id]);
  const out = new Set(roots);
  for (let frontier = [...roots]; frontier.length; ) frontier = frontier.flatMap((x) => children.get(x) ?? []).filter((x) => !out.has(x) && !!out.add(x));
  return out;
}

/**
 * The people an audience reaches: active logins only (an email or announcement needs someone to read it), once
 * each. Departments include their sub-departments. People without an employee record (often the owner) are reached
 * when chosen by name, through a group, or with "everyone".
 */
export async function resolveAudience(tx: TenantTx, a: AudienceInput, opts: { lenient?: boolean } = {}): Promise<AudienceMember[]> {
  const members = await tx.collection('memberships').find({ status: 'active' }, { projection: { employee_id: 1 } });
  const active = new Map(members.map((m) => [m.id as string, (m.employee_id as string | null) ?? null]));
  const employees = await tx.collection('employees').find(
    { status: { $in: CURRENT_STATUSES }, membership_id: { $ne: null } },
    { projection: { membership_id: 1, current_department_id: 1, current_designation_id: 1 } },
  );
  const byMembership = new Map(employees.map((e) => [e.membership_id as string, e]));
  const chosen = new Set<string>();
  if (a.all) {
    for (const id of active.keys()) chosen.add(id);
  } else {
    for (const id of a.membershipIds) chosen.add(id);
    if (a.groupIds.length) {
      const groups = await tx.collection('comm_groups').find({ id: { $in: a.groupIds }, archived_at: null }, { projection: { membership_ids: 1 } });
      // A saved announcement may name a group deleted since; then it reaches the groups that remain (lenient).
      if (!opts.lenient && groups.length !== new Set(a.groupIds).size) throw Errors.badRequest('unknown_group', 'One of the groups no longer exists');
      for (const g of groups) for (const id of g.membership_ids as string[]) chosen.add(id);
    }
    const depts = await departmentSubtrees(tx, a.departmentIds);
    const designations = new Set(a.designationIds);
    if (depts.size || designations.size) {
      for (const e of employees) {
        if ((e.current_department_id && depts.has(e.current_department_id)) || (e.current_designation_id && designations.has(e.current_designation_id))) chosen.add(e.membership_id);
      }
    }
  }
  return [...chosen]
    .filter((id) => active.has(id))
    .map((id) => ({ membershipId: id, employeeId: (byMembership.get(id)?.id as string | undefined) ?? active.get(id) ?? null }));
}

/** Names for an audience, as the screens show it ("Assembly Line, Night shift leads and 3 people"). */
export async function describeAudience(tx: TenantTx, a: Partial<AudienceInput> | null | undefined): Promise<string> {
  if (!a) return 'Nobody yet';
  if (a.all) return 'Everyone';
  const parts: string[] = [];
  const names = async (table: string, ids: string[] | undefined) =>
    ids?.length ? (await tx.collection(table).find({ id: { $in: ids } }, { projection: { name: 1 } })).map((d: Doc) => d.name as string) : [];
  parts.push(...(await names('departments', a.departmentIds)));
  parts.push(...(await names('designations', a.designationIds)));
  parts.push(...(await names('comm_groups', a.groupIds)));
  const people = a.membershipIds?.length ?? 0;
  if (people) parts.push(people === 1 ? '1 person' : `${people} people`);
  if (!parts.length) return 'Nobody yet';
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/**
 * Keeps only safe formatting from rich text: paragraphs, line breaks, bold, italic, underline, strike, headings,
 * lists, quotes and links (http, https and mailto, opened in a new tab). Everything else, including scripts, styles,
 * images and event handlers, is removed.
 */
export function safeHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'h2', 'h3', 'ul', 'ol', 'li', 'blockquote', 'a', 'div', 'span'],
    allowedAttributes: { a: ['href', 'target', 'rel'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    transformTags: { a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }) },
  }).trim();
}
