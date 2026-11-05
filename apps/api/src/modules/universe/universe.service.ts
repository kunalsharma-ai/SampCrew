import { Injectable } from '@nestjs/common';
import type { UniverseData as Universe, UniversePerson, UniverseRecord } from '@crew/contracts';
import { AuthzService } from '../../platform/authz/authz.service';
import { DatabaseService, many } from '../../platform/database/database.service';
import { EMPLOYEE_SCOPE } from '../employees/employee-attrs';

/**
 * The data behind the Workforce Universe: everyone the viewer may see, with their full placement history
 * (employment records), so the browser can rebuild the organization on any date. Scoped like the directory.
 */
@Injectable()
export class UniverseService {
  constructor(private readonly db: DatabaseService, private readonly authz: AuthzService) {}

  async load(): Promise<Universe> {
    return this.db.tenant(async (tx) => {
      const params: unknown[] = [];
      const scope = await this.authz.predicate('employees:read', EMPLOYEE_SCOPE, params, tx);
      const people = await many<UniversePerson>(
        tx,
        `select e.id, trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as name, e.employee_code as code, d.name as designation,
                to_char(e.date_of_joining, 'YYYY-MM-DD') as joined,
                case when e.status = 'exited' then to_char(coalesce(e.last_working_day, e.updated_at::date), 'YYYY-MM-DD') end as "leftOn",
                e.status, e.current_department_id as "departmentId", e.current_manager_employee_id as "managerId", e.membership_id is not null as "hasLogin"
           from employees e
           left join designations d on d.id = e.current_designation_id
          where ${scope} and e.status <> 'pre_boarding'
          order by e.date_of_joining, e.employee_code`,
        params,
      );
      const ids = people.map((p) => p.id);
      const records = ids.length
        ? await many<UniverseRecord>(
          tx,
          `select r.employee_id as "employeeId", to_char(r.effective_from, 'YYYY-MM-DD') as "from", to_char(r.effective_to, 'YYYY-MM-DD') as "to",
                  r.department_id as "departmentId", r.location_id as "locationId", r.manager_employee_id as "managerId", d.name as designation,
                  r.change_reason as reason
             from employment_records r
             left join designations d on d.id = r.designation_id
            where r.employee_id = any($1::uuid[])
            order by r.employee_id, r.effective_from`,
          [ids],
        )
        : [];
      const departments = await many<Universe['departments'][number]>(
        tx,
        `select id, name, parent_id as "parentId", archived_at is not null as archived from departments order by name`,
      );
      const locations = await many<Universe['locations'][number]>(
        tx,
        `select id, name, city, country_code as "countryCode", latitude::float8 as latitude, longitude::float8 as longitude from locations order by name`,
      );
      const asOf = new Date().toISOString().slice(0, 10);
      const start = people.reduce((m, p) => (p.joined < m ? p.joined : m), asOf);
      return { asOf, start, departments, locations, people, records };
    });
  }
}
