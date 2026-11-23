import { DEFAULT_DOCUMENT_ACCESS, effectiveDocumentAccess, type DocumentAccess } from '@crew/contracts';
import { can, type Grant, type Subject } from '../../platform/authz/policy';
import type { TenantTx } from '../../platform/database/mongo.service';
import { employeeAttrs } from '../employees/employee-attrs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Doc = Record<string, any>;

export type DocLevel = 'super_workspace' | 'hr_workspace' | 'employee_workspace';

export const CENTRAL = 'central';

/** The document access switches Super Workspace set, by HR Workspace id (or 'central' for company-wide HR). */
export interface AccessBook {
  get(scope: string | null): DocumentAccess;
  shared(scope: string | null): string[];
  row(scope: string): Doc | undefined;
}

export async function loadAccessBook(tx: TenantTx): Promise<AccessBook> {
  const rows = new Map((await tx.collection('document_access_settings').find({})).map((r) => [r.scope_key as string, r]));
  return {
    get: (scope) => effectiveDocumentAccess(rows.get(scope ?? CENTRAL)?.switches ?? DEFAULT_DOCUMENT_ACCESS),
    shared: (scope) => ((rows.get(scope ?? CENTRAL)?.shared_hr_workspace_ids ?? []) as string[]),
    row: (scope) => rows.get(scope),
  };
}

/**
 * Who is looking, as the document rules see them: Super Workspace (the whole company), HR Workspace (company-wide or
 * for some HR Workspaces, always within the switches Super Workspace set), or an employee (their own documents).
 */
export interface Viewer {
  s: Subject;
  isSuper: boolean;
  /** HR Workspace documents grants (documents:read on the HR level), or null for people without HR Workspace. */
  hr: null | { companyWide: boolean; workspaceIds: string[]; grants: Grant[] };
  book: AccessBook;
  level: DocLevel;
}

export function levelGrants(s: Subject, roleKey: string, permission: string): Grant[] {
  return s.grants.filter((g) => g.roleKey === roleKey && g.permission === permission);
}

export function hrInfo(s: Subject, permission = 'documents:read'): Viewer['hr'] {
  // An HR Workspace person whose documents grant reaches only their own record (a payroll or attendance lead, say)
  // works with documents as an employee does.
  const grants = levelGrants(s, 'hr_workspace', permission).filter((g) => g.scope !== 'own');
  if (!grants.length) return null;
  return { companyWide: grants.some((g) => !g.constraints.hrWorkspaceIds?.length), workspaceIds: [...new Set(grants.flatMap((g) => g.constraints.hrWorkspaceIds ?? []))], grants };
}

export async function viewerOf(tx: TenantTx, s: Subject): Promise<Viewer> {
  const isSuper = levelGrants(s, 'super_workspace', 'documents:read').length > 0;
  const hr = isSuper ? null : hrInfo(s);
  return { s, isSuper, hr, book: await loadAccessBook(tx), level: isSuper ? 'super_workspace' : hr ? 'hr_workspace' : 'employee_workspace' };
}

/** The switches that govern an HR person for something in this HR Workspace (null: the central group). */
export function accessFor(v: Viewer, hrWorkspaceId: string | null): DocumentAccess | null {
  if (!v.hr) return null;
  if (v.hr.companyWide) return v.book.get(CENTRAL);
  if (hrWorkspaceId && v.hr.workspaceIds.includes(hrWorkspaceId)) return v.book.get(hrWorkspaceId);
  return null;
}

/** Other HR Workspaces' documents this HR person may read (read only), with the switches that apply. */
export function sharedAccess(v: Viewer, hrWorkspaceId: string | null): DocumentAccess | null {
  if (!v.hr || !hrWorkspaceId) return null;
  const scopes = v.hr.companyWide ? [CENTRAL] : v.hr.workspaceIds;
  for (const scope of scopes) {
    const a = v.book.get(scope === CENTRAL ? null : scope);
    if (a.view_other_hr && v.book.shared(scope === CENTRAL ? null : scope).includes(hrWorkspaceId) && scope !== hrWorkspaceId) return a;
  }
  return null;
}

export function employeeAttrsOf(e: Doc) {
  return employeeAttrs({ id: e.id, membershipId: e.membership_id ?? null, legalEntityId: e.current_legal_entity_id ?? null, departmentId: e.current_department_id ?? null, locationId: e.current_location_id ?? null });
}

/** Does the HR level of the subject cover this employee (their grant's departments, entities, HR Workspaces)? */
export function hrCovers(v: Viewer, e: Doc, permission = 'documents:read'): boolean {
  if (!v.hr) return false;
  const grants = levelGrants(v.s, 'hr_workspace', permission).filter((g) => g.scope !== 'own');
  return grants.length > 0 && can({ ...v.s, grants }, permission, employeeAttrsOf(e)).allowed;
}

/** pending / verified / rejected / correction_required / unverified. */
export function statusOf(d: Doc): string {
  return (d.verification_status as string | null | undefined) ?? 'unverified';
}

export function statusAllowed(a: DocumentAccess, status: string): boolean {
  if (a.view_employee) return true;
  if (status === 'verified' || status === 'unverified') return a.view_approved;
  return a.view_pending;
}

export const STATUS_GROUPS: Record<'approved' | 'pending', (string | null)[]> = {
  approved: ['verified', null],
  pending: ['pending', 'rejected', 'correction_required'],
};

/** The verification_status values an HR person may see under these switches (null = not verified). */
export function allowedStatuses(a: DocumentAccess): (string | null)[] {
  if (a.view_employee) return [...STATUS_GROUPS.approved, ...STATUS_GROUPS.pending];
  return [...(a.view_approved ? STATUS_GROUPS.approved : []), ...(a.view_pending ? STATUS_GROUPS.pending : [])];
}

/** Active HR Workspace Admins of these HR Workspaces (membership ids). */
export async function hrWorkspaceAdmins(tx: TenantTx, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  const role = await tx.collection('roles').findOne({ key: 'hr_workspace', is_system: true });
  if (!role || !ids.length) return out;
  const rows = await tx.collection('role_assignments').find({ role_id: role.id, 'constraints.hrWorkspaceIds': { $in: ids } });
  const active = new Set(await tx.collection('memberships').distinct<string>('id', { id: { $in: rows.map((r) => r.membership_id) }, status: 'active' }));
  for (const r of rows) {
    if (!active.has(r.membership_id)) continue;
    for (const id of (r.constraints?.hrWorkspaceIds ?? []) as string[]) if (out.has(id)) out.get(id)!.push(r.membership_id as string);
  }
  return out;
}

/** Active company-wide HR Workspace people (no HR Workspace limit), for central-group notices. */
export async function companyWideHr(tx: TenantTx): Promise<string[]> {
  const role = await tx.collection('roles').findOne({ key: 'hr_workspace', is_system: true });
  if (!role) return [];
  const rows = await tx.collection('role_assignments').find({ role_id: role.id });
  const ids = rows.filter((r) => !((r.constraints?.hrWorkspaceIds ?? []) as string[]).length).map((r) => r.membership_id as string);
  return tx.collection('memberships').distinct<string>('id', { id: { $in: ids }, status: 'active' });
}

export function refOf(prefix: string, id: string) {
  return `${prefix}-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}
