import type { ResourceAttributes } from '../../platform/authz/policy';
import { one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { employeeAttrs } from '../employees/employee-attrs';

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

/** Display name of an employee row aliased `alias`. */
export const nameOf = (alias: string) => `trim(coalesce(${alias}.preferred_name, ${alias}.first_name) || ' ' || ${alias}.last_name)`;

export async function talentEmployee(tx: Tx, id: string, what = 'Employee'): Promise<TalentEmployee> {
  const e = await one<TalentEmployee>(
    tx,
    `select e.id, e.membership_id, e.current_legal_entity_id as legal_entity_id, e.current_department_id as department_id,
            e.current_location_id as location_id, e.current_manager_employee_id as manager_employee_id, m.membership_id as manager_membership_id,
            ${nameOf('e')} as name, e.status
       from employees e left join employees m on m.id = e.current_manager_employee_id
      where e.id = $1`,
    [id],
  );
  if (!e) throw Errors.notFound(what);
  return e;
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
