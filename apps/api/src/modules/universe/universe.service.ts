import { Injectable } from '@nestjs/common';
import type { UniverseData as Universe, UniversePerson, UniverseRecord } from '@crew/contracts';
import { AuthzService } from '../../platform/authz/authz.service';
import { MongoService as DatabaseService } from '../../platform/database/mongo.service';
import { EMPLOYEE_FIELDS } from '../employees/employee-attrs';
import { displayName, fieldById } from '../employees/employee-view';

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * The data behind the Workforce Universe: everyone the viewer may see, with their full placement history
 * (employment records), so the browser can rebuild the organization on any date. Scoped like the directory.
 */
@Injectable()
export class UniverseService {
  constructor(private readonly db: DatabaseService, private readonly authz: AuthzService) {}

  async load(): Promise<Universe> {
    return this.db.tenant(async (tx) => {
      const scope = await this.authz.filter('employees:read', EMPLOYEE_FIELDS, tx);
      const employees = await tx.collection('employees').find({ $and: [scope, { status: { $ne: 'pre_boarding' } }] }, { sort: { date_of_joining: 1, employee_code: 1 } });
      const titles = await fieldById(tx, 'designations', employees.map((e) => e.current_designation_id));
      const people: UniversePerson[] = employees.map((e) => ({
        id: e.id, name: displayName(e as never), code: e.employee_code, designation: titles.get(e.current_designation_id) ?? null,
        joined: e.date_of_joining,
        leftOn: e.status === 'exited' ? (e.last_working_day ?? (e.updated_at as Date).toISOString().slice(0, 10)) : null,
        status: e.status, departmentId: e.current_department_id ?? null, managerId: e.current_manager_employee_id ?? null, hasLogin: e.membership_id != null,
      }) as UniversePerson);
      const ids = people.map((p) => p.id);
      const recs = ids.length ? await tx.collection('employment_records').find({ employee_id: { $in: ids } }, { sort: { employee_id: 1, effective_from: 1 } }) : [];
      const recTitles = await fieldById(tx, 'designations', recs.map((r) => r.designation_id));
      const records: UniverseRecord[] = recs.map((r) => ({
        employeeId: r.employee_id, from: r.effective_from, to: r.effective_to ?? null, departmentId: r.department_id ?? null, locationId: r.location_id ?? null,
        managerId: r.manager_employee_id ?? null, designation: recTitles.get(r.designation_id) ?? null, reason: r.change_reason ?? null,
      }) as UniverseRecord);
      const departments = (await tx.collection('departments').find({}, { sort: { name: 1 } }))
        .map((d) => ({ id: d.id, name: d.name, parentId: d.parent_id ?? null, archived: d.archived_at != null })) as Universe['departments'];
      const locations = (await tx.collection('locations').find({}, { sort: { name: 1 } }))
        .map((l) => ({ id: l.id, name: l.name, city: l.city ?? null, countryCode: l.country_code ?? null, latitude: num(l.latitude), longitude: num(l.longitude) })) as Universe['locations'];
      const asOf = new Date().toISOString().slice(0, 10);
      const start = people.reduce((m, p) => (p.joined < m ? p.joined : m), asOf);
      return { asOf, start, departments, locations, people, records };
    });
  }
}
