import { automation, caseRef, type TriggerEvent } from '@crew/contracts';
import { one, type Tx } from '../../platform/database/database.service';

export type RunContext = automation.Context;

/** Fields about an employee that workflows may use. Pay, bank, tax and national IDs are never included. */
export async function employeeContext(tx: Tx, employeeId: string): Promise<RunContext | null> {
  const e = await one<Record<string, string | null>>(
    tx,
    `select trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as name, g.name as title, d.name as department, l.name as location,
            le.name as "legalEntity", e.employment_type as "employmentType", to_char(e.date_of_joining, 'YYYY-MM-DD') as "dateOfJoining", e.status
       from employees e left join designations g on g.id = e.current_designation_id left join departments d on d.id = e.current_department_id
       left join locations l on l.id = e.current_location_id left join legal_entities le on le.id = e.current_legal_entity_id
      where e.id = $1`,
    [employeeId],
  );
  if (!e) return null;
  return Object.fromEntries(Object.entries(e).map(([k, v]) => [`employee.${k}`, v]));
}

const changeKind = (changed: string[]) =>
  changed.some((c) => c === 'designation_id' || c === 'grade') ? 'promotion'
    : changed.some((c) => ['department_id', 'location_id', 'legal_entity_id'].includes(c)) ? 'transfer'
      : changed.includes('manager_employee_id') ? 'manager_change' : 'other';

/**
 * Builds a run's context from a domain event. Returns null when the event must not start a workflow (for
 * example a confidential helpdesk case, or a record that no longer exists).
 */
export async function contextForEvent(tx: Tx, event: TriggerEvent, payload: Record<string, unknown>): Promise<{ employeeId: string; context: RunContext } | null> {
  const employeeId = payload.employeeId as string | undefined;
  if (!employeeId) return null;
  const base = await employeeContext(tx, employeeId);
  if (!base) return null;
  switch (event) {
    case 'employee.created':
      return { employeeId, context: base };
    case 'employee.job_changed':
      return { employeeId, context: { ...base, 'change.kind': changeKind((payload.changed as string[] | undefined) ?? []), 'change.effectiveDate': (payload.effectiveFrom as string | undefined) ?? null } };
    case 'leave.requested':
    case 'leave.approved': {
      const l = await one<{ type: string; days: string; from: string; to: string }>(
        tx,
        `select t.name as type, r.days::text as days, to_char(r.start_date, 'YYYY-MM-DD') as "from", to_char(r.end_date, 'YYYY-MM-DD') as "to"
           from leave_requests r join leave_types t on t.id = r.leave_type_id where r.id = $1`,
        [payload.leaveRequestId],
      );
      if (!l) return null;
      return { employeeId, context: { ...base, 'leave.type': l.type, 'leave.days': Number(l.days), 'leave.from': l.from, 'leave.to': l.to } };
    }
    case 'helpdesk.case_created': {
      const c = await one<{ number: number; category: string; priority: string; confidential: boolean }>(
        tx, `select c.number, k.name as category, c.priority, c.confidential from helpdesk_cases c join helpdesk_categories k on k.id = c.category_id where c.id = $1`, [payload.caseId],
      );
      if (!c || c.confidential) return null;
      return { employeeId, context: { ...base, 'case.ref': caseRef(c.number), 'case.category': c.category, 'case.priority': c.priority } };
    }
  }
}
