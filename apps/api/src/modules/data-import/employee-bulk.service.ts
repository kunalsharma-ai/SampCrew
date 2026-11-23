import { Injectable } from '@nestjs/common';
import type { EmployeeBulkInput, EmployeeBulkResult } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { MongoService as DatabaseService } from '../../platform/database/mongo.service';
import { AppError, Errors } from '../../platform/http/errors';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantsFor } from '../../platform/authz/policy';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { EMPLOYEE_FIELDS } from '../employees/employee-attrs';
import { EmployeesService } from '../employees/employees.service';

/**
 * Bulk changes to employees picked in the list: a new department, job title, location or manager (each a dated job
 * change, kept in the history), or one custom field set for all of them. Each person is changed in a transaction of
 * their own with the same permission checks as one by one, so someone outside the caller's scope is refused alone.
 */
@Injectable()
export class EmployeeBulkService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly authz: AuthzService,
    private readonly employees: EmployeesService,
    private readonly customFields: CustomFieldsService,
  ) {}

  async apply(input: EmployeeBulkInput): Promise<EmployeeBulkResult> {
    // Changing other people: their own-profile access is not enough.
    const permission = input.action === 'custom_field' ? 'employees:update' : 'employees:lifecycle';
    const s = await this.db.tenant((tx) => this.authz.subject(tx));
    if (!grantsFor(s, permission).some((g) => g.scope !== 'own')) throw Errors.forbidden('You cannot change other people in bulk');
    const ids = [...new Set(input.employeeIds)];
    const names = new Map((await this.db.tenant(async (tx) => tx.collection('employees').find({ $and: [{ id: { $in: ids } }, await this.authz.filter('employees:read', EMPLOYEE_FIELDS, tx)] }, { projection: { first_name: 1, last_name: 1, employee_code: 1 } })))
      .map((e) => [e.id as string, `${e.first_name as string} ${(e.last_name as string) ?? ''}`.trim() + ` (${e.employee_code as string})`]));
    const results: EmployeeBulkResult['results'] = [];
    for (const id of ids) {
      try {
        if (input.action === 'custom_field') {
          await this.db.tenant((tx) => this.customFields.save('employee', id, { [input.key]: input.value }, { tx }));
        } else {
          const change = {
            effectiveFrom: input.effectiveFrom, reason: input.action === 'manager' ? 'manager_change' : 'transfer', note: input.note ?? 'Bulk change',
            ...(input.action === 'department' ? { departmentId: input.departmentId } : input.action === 'job_title' ? { designationId: input.designationId } : input.action === 'location' ? { locationId: input.locationId } : { managerEmployeeId: input.managerEmployeeId }),
          };
          await this.db.tenant((tx) => this.employees.changeJobIn(tx, id, change as never));
        }
        results.push({ employeeId: id, name: names.get(id) ?? null, ok: true, message: null });
      } catch (err) {
        // Someone the caller cannot see is reported without their name (only people they can see are named).
        const details = err instanceof AppError && Array.isArray(err.details) ? (err.details as { message: string }[]).map((d) => d.message).join('; ') : null;
        results.push({ employeeId: id, name: names.get(id) ?? null, ok: false, message: details || (err instanceof AppError ? err.message : 'Could not be changed') });
      }
    }
    const done = results.filter((r) => r.ok).length;
    await this.db.tenant((tx) => this.audit.record(tx, { action: 'employee.bulk_changed', resourceType: 'employee', resourceId: null, changes: { action: input.action, employees: ids.length, done, failed: ids.length - done } }));
    return { done, failed: ids.length - done, results };
  }
}
