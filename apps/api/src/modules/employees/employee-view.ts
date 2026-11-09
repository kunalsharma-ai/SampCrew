import type { TenantTx } from '../../platform/database/mongo.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

export interface EmployeeRow {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  displayName: string;
  workEmail: string | null;
  status: string;
  dateOfJoining: string;
  probationEndDate: string | null;
  confirmationDate: string | null;
  lastWorkingDay: string | null;
  legalEntityId: string | null;
  departmentId: string | null;
  locationId: string | null;
  designationId: string | null;
  managerEmployeeId: string | null;
  grade: string | null;
  employmentType: string;
  membershipId: string | null;
  [key: string]: unknown;
}

/** "Preferred or first name, last name", as the directory shows a person. */
export function displayName(e: { preferred_name?: string | null; first_name: string; last_name?: string | null }): string {
  return `${e.preferred_name ?? e.first_name} ${e.last_name ?? ''}`.trim();
}

const uniq = (ids: unknown[]) => [...new Set(ids.filter((x): x is string => typeof x === 'string'))];

/** Values of one field of rows in a table, by id, for the given ids. */
export async function fieldById(tx: TenantTx, table: string, ids: unknown[], field = 'name'): Promise<Map<string, string>> {
  const list = uniq(ids);
  if (!list.length) return new Map();
  const rows = await tx.collection(table).find({ id: { $in: list } }, { projection: { [field]: 1 } });
  return new Map(rows.map((r) => [r.id as string, r[field] as string]));
}

/** Employees by id: their display name and login, for showing who did something or who someone reports to. */
export async function employeeNames(tx: TenantTx, ids: unknown[]): Promise<Map<string, { name: string; membershipId: string | null; doc: Doc }>> {
  const list = uniq(ids);
  if (!list.length) return new Map();
  const rows = await tx.collection('employees').find({ id: { $in: list } });
  return new Map(rows.map((e) => [e.id as string, { name: displayName(e as never), membershipId: (e.membership_id as string | null) ?? null, doc: e }]));
}

/**
 * Employee documents as the API shows them (the PostgreSQL EMPLOYEE_COLUMNS view): placement names, the manager's
 * name and the login status, loaded in one batch per referenced table.
 */
export async function employeeViews(tx: TenantTx, docs: Doc[]): Promise<EmployeeRow[]> {
  if (!docs.length) return [];
  const [entities, departments, locations, designations, managers, logins] = await Promise.all([
    fieldById(tx, 'legal_entities', docs.map((e) => e.current_legal_entity_id)),
    fieldById(tx, 'departments', docs.map((e) => e.current_department_id)),
    fieldById(tx, 'locations', docs.map((e) => e.current_location_id)),
    fieldById(tx, 'designations', docs.map((e) => e.current_designation_id)),
    employeeNames(tx, docs.map((e) => e.current_manager_employee_id)),
    fieldById(tx, 'memberships', docs.map((e) => e.membership_id), 'status'),
  ]);
  return docs.map((e) => ({
    id: e.id,
    employeeCode: e.employee_code,
    firstName: e.first_name,
    lastName: e.last_name,
    preferredName: e.preferred_name ?? null,
    displayName: displayName(e as never),
    workEmail: e.work_email ?? null,
    personalEmail: e.personal_email ?? null,
    phone: e.phone ?? null,
    dateOfBirth: e.date_of_birth ?? null,
    gender: e.gender ?? null,
    dateOfJoining: e.date_of_joining,
    probationEndDate: e.probation_end_date ?? null,
    confirmationDate: e.confirmation_date ?? null,
    employmentType: e.employment_type,
    status: e.status,
    resignationDate: e.resignation_date ?? null,
    lastWorkingDay: e.last_working_day ?? null,
    exitType: e.exit_type ?? null,
    exitReason: e.exit_reason ?? null,
    legalEntityId: e.current_legal_entity_id ?? null,
    legalEntityName: entities.get(e.current_legal_entity_id) ?? null,
    departmentId: e.current_department_id ?? null,
    departmentName: departments.get(e.current_department_id) ?? null,
    locationId: e.current_location_id ?? null,
    locationName: locations.get(e.current_location_id) ?? null,
    designationId: e.current_designation_id ?? null,
    designationName: designations.get(e.current_designation_id) ?? null,
    managerEmployeeId: e.current_manager_employee_id ?? null,
    managerName: managers.get(e.current_manager_employee_id)?.name ?? null,
    grade: e.current_grade ?? null,
    membershipId: e.membership_id ?? null,
    loginStatus: logins.get(e.membership_id) ?? null,
    createdAt: e.created_at,
    photoUpdatedAt: e.photo_updated_at ?? null,
    defaultShiftId: e.default_shift_id ?? null,
  }));
}

/**
 * Copies the employment record in effect on `on` into each employee's current placement, and keeps their login's
 * membership in step (the employees_apply_current function and employees_sync_membership trigger in PostgreSQL).
 * Idempotent: run after every job change and daily, so future-dated changes take effect on their date.
 */
export async function applyCurrentPlacement(tx: TenantTx, on: string, employeeIds?: string[]): Promise<number> {
  const records = await tx.collection('employment_records').find(
    { effective_from: { $lte: on }, $or: [{ effective_to: null }, { effective_to: { $gte: on } }], ...(employeeIds ? { employee_id: { $in: employeeIds } } : {}) },
    { sort: { effective_from: -1 } },
  );
  const due = new Map<string, Doc>();
  for (const r of records) if (!due.has(r.employee_id)) due.set(r.employee_id, r);
  if (!due.size) return 0;
  const employees = await tx.collection('employees').find({ id: { $in: [...due.keys()] } });
  let n = 0;
  for (const e of employees) {
    const r = due.get(e.id)!;
    const next = {
      current_legal_entity_id: r.legal_entity_id ?? null,
      current_department_id: r.department_id ?? null,
      current_location_id: r.location_id ?? null,
      current_designation_id: r.designation_id ?? null,
      current_manager_employee_id: r.manager_employee_id ?? null,
      current_grade: r.grade ?? null,
      employment_type: r.employment_type,
    };
    if (Object.entries(next).every(([k, v]) => (e[k] ?? null) === v)) continue;
    await tx.collection('employees').updateOne({ id: e.id }, { $set: next });
    await syncMembership(tx, e.id);
    n++;
  }
  return n;
}

/**
 * An employee's login follows their placement: entity, department, location, manager (as a membership) and title.
 * People who report to this employee follow their manager's membership too.
 */
export async function syncMembership(tx: TenantTx, employeeId: string): Promise<void> {
  const e = await tx.collection('employees').findOne({ id: employeeId });
  if (!e?.membership_id) return;
  const manager = e.current_manager_employee_id ? await tx.collection('employees').findOne({ id: e.current_manager_employee_id }) : undefined;
  const designation = e.current_designation_id ? await tx.collection('designations').findOne({ id: e.current_designation_id }) : undefined;
  await tx.collection('memberships').updateOne(
    { id: e.membership_id },
    {
      $set: {
        legal_entity_id: e.current_legal_entity_id ?? null,
        department_id: e.current_department_id ?? null,
        location_id: e.current_location_id ?? null,
        manager_membership_id: manager?.membership_id ?? null,
        employee_id: e.id,
        ...(designation ? { title: designation.name } : {}),
      },
    },
  );
  const reports = await tx.collection('employees').find({ current_manager_employee_id: employeeId, membership_id: { $ne: null } }, { projection: { membership_id: 1 } });
  if (reports.length) await tx.collection('memberships').update({ id: { $in: reports.map((r) => r.membership_id) } }, { $set: { manager_membership_id: e.membership_id } });
}

/** True when making `managerId` the manager of `employeeId` would create a reporting loop (employees_no_manager_cycle). */
export async function managerCycle(tx: TenantTx, employeeId: string, managerId: string | null | undefined): Promise<boolean> {
  if (!managerId) return false;
  if (managerId === employeeId) return true;
  const managers = new Map(
    (await tx.collection('employees').find({ current_manager_employee_id: { $ne: null } }, { projection: { current_manager_employee_id: 1 } })).map((e) => [
      e.id as string,
      e.current_manager_employee_id as string,
    ]),
  );
  for (let at: string | undefined = managerId, depth = 0; at && depth < 100; at = managers.get(at), depth++) if (at === employeeId) return true;
  return false;
}
