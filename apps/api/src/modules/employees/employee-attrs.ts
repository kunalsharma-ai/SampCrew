import type { ResourceAttributes } from '../../platform/authz/policy';

/** ABAC attributes of an employee record: the person, their login, and where they sit in the organisation. */
export function employeeAttrs(e: { id: string; membershipId: string | null; legalEntityId: string | null; departmentId: string | null; locationId: string | null }): ResourceAttributes {
  return { employeeId: e.id, membershipId: e.membershipId, legalEntityId: e.legalEntityId, departmentId: e.departmentId, locationId: e.locationId };
}
