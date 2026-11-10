import { automation, caseRef, type TriggerEvent } from '@crew/contracts';
import type { TenantTx as Tx } from '../../platform/database/mongo.service';
import { displayName, fieldById } from '../employees/employee-view';

export type RunContext = automation.Context;

/** Fields about an employee that workflows may use. Pay, bank, tax and national IDs are never included. */
export async function employeeContext(tx: Tx, employeeId: string): Promise<RunContext | null> {
  const doc = await tx.collection('employees').findOne({ id: employeeId });
  if (!doc) return null;
  const nameIn = async (table: string, id: unknown) => (await fieldById(tx, table, [id])).get(id as string) ?? null;
  const e: Record<string, string | null> = {
    name: displayName(doc as never), title: await nameIn('designations', doc.current_designation_id), department: await nameIn('departments', doc.current_department_id),
    location: await nameIn('locations', doc.current_location_id), legalEntity: await nameIn('legal_entities', doc.current_legal_entity_id),
    employmentType: doc.employment_type ?? null, dateOfJoining: doc.date_of_joining ?? null, status: doc.status ?? null,
  };
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
      const l = await tx.collection('leave_requests').findOne({ id: payload.leaveRequestId });
      if (!l) return null;
      const type = (await fieldById(tx, 'leave_types', [l.leave_type_id])).get(l.leave_type_id) ?? null;
      return { employeeId, context: { ...base, 'leave.type': type, 'leave.days': Number(l.days), 'leave.from': l.start_date, 'leave.to': l.end_date } };
    }
    case 'helpdesk.case_created': {
      const c = await tx.collection('helpdesk_cases').findOne({ id: payload.caseId });
      if (!c || c.confidential) return null;
      const category = (await fieldById(tx, 'helpdesk_categories', [c.category_id])).get(c.category_id) ?? null;
      return { employeeId, context: { ...base, 'case.ref': caseRef(c.number), 'case.category': category, 'case.priority': c.priority } };
    }
  }
}
