import type { ResourceAttributes } from '../../platform/authz/policy';

/** ABAC attributes of an employee record: the person, their login, and where they sit in the organisation. */
export function employeeAttrs(e: { id: string; membershipId: string | null; legalEntityId: string | null; departmentId: string | null; locationId: string | null }): ResourceAttributes {
  return { employeeId: e.id, membershipId: e.membershipId, legalEntityId: e.legalEntityId, departmentId: e.departmentId, locationId: e.locationId };
}

/** SQL columns of an employee row aliased `e`, for pushing ABAC scopes into list queries. */
export const EMPLOYEE_SCOPE = {
  membershipId: 'e.membership_id',
  legalEntityId: 'e.current_legal_entity_id',
  departmentId: 'e.current_department_id',
  locationId: 'e.current_location_id',
  employeeId: 'e.id',
};

/** MongoDB fields of an employee document, for AuthzService.filter on employee lists. */
export const EMPLOYEE_FIELDS = {
  membershipId: 'membership_id',
  legalEntityId: 'current_legal_entity_id',
  departmentId: 'current_department_id',
  locationId: 'current_location_id',
  employeeId: 'id',
};
