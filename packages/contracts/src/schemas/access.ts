import { z } from 'zod';
import { SCOPES } from '../permissions';
import { email, name } from './common';

export const inviteMemberRequest = z.object({
  email,
  fullName: name,
  roleKeys: z.array(z.string().min(1).max(64)).min(1).max(10),
  departmentId: z.uuid().nullable().optional(),
  legalEntityId: z.uuid().nullable().optional(),
  locationId: z.uuid().nullable().optional(),
  managerMembershipId: z.uuid().nullable().optional(),
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
