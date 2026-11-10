import type { ResourceAttributes } from '../../platform/authz/policy';
import type { TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { employeeAttrs } from '../employees/employee-attrs';
import { displayName } from '../employees/employee-view';

export interface TalentEmployee {
  id: string;
  membership_id: string | null;
  legal_entity_id: string | null;
  department_id: string | null;
  location_id: string | null;
  manager_employee_id: string | null;
  manager_membership_id: string | null;
  name: string;
  status: string;
}

export async function talentEmployee(tx: TenantTx, id: string, what = 'Employee'): Promise<TalentEmployee> {
  const e = await tx.collection('employees').findOne({ id });
  if (!e) throw Errors.notFound(what);
  const manager = e.current_manager_employee_id ? await tx.collection('employees').findOne({ id: e.current_manager_employee_id }, { projection: { membership_id: 1 } }) : undefined;
  return {
    id: e.id, membership_id: e.membership_id ?? null, legal_entity_id: e.current_legal_entity_id ?? null, department_id: e.current_department_id ?? null,
    location_id: e.current_location_id ?? null, manager_employee_id: e.current_manager_employee_id ?? null, manager_membership_id: manager?.membership_id ?? null,
    name: displayName(e as never), status: e.status,
  };
}

export const attrsOf = (e: TalentEmployee): ResourceAttributes =>
  employeeAttrs({ id: e.id, membershipId: e.membership_id, legalEntityId: e.legal_entity_id, departmentId: e.department_id, locationId: e.location_id });

/** The caller's own employee record, or a clear error for logins that are not linked to one. */
export function needEmployee(employeeId: string | null | undefined): string {
  if (!employeeId) throw Errors.badRequest('no_employee_record', 'Your login is not linked to an employee record yet. Ask HR to link it.');
  return employeeId;
}

/** Keeps only answers to known questions. */
export function pickAnswers(questions: { id: string }[], answers: Record<string, string>): Record<string, string> {
  const ids = new Set(questions.map((q) => q.id));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(answers)) {
    if (!ids.has(k)) throw Errors.badRequest('unknown_question', 'An answer does not match any question');
    if (v) out[k] = v;
  }
  return out;
}
