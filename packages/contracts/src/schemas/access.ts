import { z } from 'zod';
import { SCOPES } from '../permissions';
import { email, name } from './common';

/**
 * A person's workspace access (one of the four access categories; Console Admin is given in the Console). Everyone
 * keeps Employee Workspace. HR Workspace can be limited to HR Workspaces, legal entities or departments, and to some
 * areas (or to viewing them); with no limits it covers the whole company.
 */
export const ACCESS_LEVELS = ['super', 'hr', 'employee'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];
export const setAccessRequest = z
  .object({
    level: z.enum(ACCESS_LEVELS),
    hrWorkspaceIds: z.array(z.uuid()).max(50).optional(),
    legalEntityIds: z.array(z.uuid()).max(50).optional(),
    departmentIds: z.array(z.uuid()).max(200).optional(),
    areas: z.array(z.string().min(2).max(60)).max(40).optional(),
    viewAreas: z.array(z.string().min(2).max(60)).max(40).optional(),
    auditTrail: z.boolean().optional(),
  })
  .strict();
export type SetAccessRequest = z.infer<typeof setAccessRequest>;

/** How the API shows a person's access. */
export interface MemberAccess {
  level: AccessLevel;
  /** "Super Workspace", "HR Workspace" or "Employee Workspace". */
  label: string;
  /** The HR Workspaces an HR Workspace person is limited to (empty: not limited to HR Workspaces). */
  hrWorkspaces: { id: string; name: string }[];
  legalEntityIds: string[];
  departmentIds: string[];
  /** Areas looked after in full and view-only (both empty: every area). */
  areas: string[];
  viewAreas: string[];
  auditTrail: boolean;
  /** Given by a provisioning group (SCIM): the identity provider manages it. */
  fromGroup: boolean;
}


export const inviteMemberRequest = z.object({
  email,
  fullName: name,
  /** Before the four access levels: role keys, mapped to the level they became. `access` says it directly. */
  roleKeys: z.array(z.string().min(1).max(64)).min(1).max(10).default(['employee_workspace']),
  departmentId: z.uuid().nullable().optional(),
  legalEntityId: z.uuid().nullable().optional(),
  locationId: z.uuid().nullable().optional(),
  managerMembershipId: z.uuid().nullable().optional(),
  /** Workspace access to give (Employee Workspace when left out). */
  access: setAccessRequest.optional(),
});

export const updateMemberRequest = z.object({
  departmentId: z.uuid().nullable().optional(),
  legalEntityId: z.uuid().nullable().optional(),
  locationId: z.uuid().nullable().optional(),
  managerMembershipId: z.uuid().nullable().optional(),
  status: z.enum(['active', 'suspended']).optional(),
});

export const roleGrant = z.object({ permission: z.string().min(3).max(64), scope: z.enum(SCOPES) });

export const customRoleInput = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/, 'Lowercase letters, numbers and underscores; start with a letter'),
  name,
  description: z.string().max(500).optional(),
  grants: z.array(roleGrant).min(1).max(200),
});

export const assignmentConstraints = z
  .object({
    legalEntityIds: z.array(z.uuid()).max(50).optional(),
    departmentIds: z.array(z.uuid()).max(200).optional(),
    locationIds: z.array(z.uuid()).max(200).optional(),
  })
  .strict();
export type AssignmentConstraints = z.infer<typeof assignmentConstraints>;

export const assignRolesRequest = z.object({
  assignments: z.array(z.object({ roleKey: z.string().min(1).max(64), constraints: assignmentConstraints.optional() })).min(1).max(20),
});

