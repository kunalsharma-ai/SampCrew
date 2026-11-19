import { Injectable } from '@nestjs/common';
import {
  type CreateEmployeeInput,
  createEmployeeInput,
  EMPLOYEE_IMPORT_COLUMNS,
  type EmployeeImportColumn,
  EMPLOYMENT_TYPES,
  GENDERS,
  IMPORT_MAX_ROWS,
  type ImportResult,
  type ImportRowResult,
  importHeaderKey,
  LEAVE_COLUMN_PREFIX,
  parseSheetDate,
  phoneError,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { parseCsv, readXlsx, toXlsx } from '../../platform/export/tabular';
import { AppError, Errors } from '../../platform/http/errors';
import type { UploadedFile } from '../../platform/storage/uploads';
import { AssetsService } from '../assets/assets.service';
import { EmployeesService } from '../employees/employees.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
const lc = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const digitsOf = (v: unknown) => String(v ?? '').replace(/\D/g, '');
const slug = (v: string) => lc(v).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const today = () => new Date().toISOString().slice(0, 10);

/** Labels used in messages, so HR sees the column as it is named in the template. */
const LABEL: Record<string, string> = Object.fromEntries(EMPLOYEE_IMPORT_COLUMNS.map((c) => [c.key, c.label]));
/** Where a validation problem on the hire input points back to in the sheet. */
const PATH_COLUMN: Record<string, string> = {
  firstName: 'firstName', lastName: 'lastName', workEmail: 'workEmail', personalEmail: 'personalEmail', phone: 'phone', dateOfBirth: 'dateOfBirth',
  gender: 'gender', dateOfJoining: 'dateOfJoining', confirmationDate: 'confirmationDate', employeeCode: 'employeeCode', employmentType: 'employmentType',
  minorConfirmed: 'dateOfBirth', designationName: 'designation', departmentId: 'department', locationId: 'location', legalEntityId: 'legalEntity',
  managerEmployeeId: 'managerCode', openingLeaveBalances: 'leave',
};

interface Prepared {
  result: ImportRowResult;
  input?: CreateEmployeeInput;
  /** The manager is another row of this file, created first. */
  managerRow?: number;
  assetIds: string[];
}

/**
 * Bulk import of people already working here, from the CSV or Excel template: their own employee IDs, original joining
 * dates, confirmation dates, reporting lines, leave balances as of today and the assets they hold. A dry run checks
 * every row and changes nothing; the real run adds the rows that passed, each through the same hire path as the form.
 */
@Injectable()
export class EmployeeImportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly employees: EmployeesService,
    private readonly assets: AssetsService,
  ) {}

  /** The template: the columns, one line of examples, and a leave column per active leave type. */
  async template() {
    return this.db.tenant(async (tx) => {
      await this.authz.require('employees:create', undefined, tx);
      const types = await tx.collection('leave_types').find({ archived_at: null }, { sort: { code: 1 } });
      const header = [...EMPLOYEE_IMPORT_COLUMNS.map((c) => (c.required ? `${c.label} *` : c.label)), ...types.map((t) => `${LEAVE_COLUMN_PREFIX}${t.code}`)];
      const example = [...EMPLOYEE_IMPORT_COLUMNS.map((c) => c.example), ...types.map(() => '')];
      return toXlsx('Existing employees', [header, example]);
    });
  }

  async run(file: UploadedFile | undefined, dryRun: boolean): Promise<ImportResult> {
    const rows = this.read(file);
    const prepared = await this.db.tenant(async (tx) => {
      await this.authz.require('employees:create', undefined, tx);
      return this.prepare(tx, rows);
    });
    const creates = new Set<string>();
    for (const p of prepared) if (p.input?.designationName) creates.add(p.input.designationName);
    if (dryRun) return summarise(true, prepared.map((p) => p.result), [...creates]);

    // Rows whose manager is another row wait for that row; a manager row that fails takes its reports with it.
    const created = new Map<number, string>();
    const pending = prepared.filter((p) => p.result.status === 'ok');
    let progress = true;
    while (pending.length && progress) {
      progress = false;
      for (let i = 0; i < pending.length; i++) {
        const p = pending[i]!;
        if (p.managerRow !== undefined && !created.has(p.managerRow)) {
          const managerRow = prepared.find((x) => x.result.row === p.managerRow);
          if (managerRow && managerRow.result.status !== 'ok' && managerRow.result.status !== 'created') {
            p.result.status = 'error';
            p.result.errors.push({ column: LABEL.managerCode!, message: `Their manager (row ${p.managerRow}) was not added` });
            pending.splice(i--, 1);
            progress = true;
          }
          continue;
        }
        pending.splice(i--, 1);
        progress = true;
        const input = { ...p.input!, ...(p.managerRow !== undefined ? { managerEmployeeId: created.get(p.managerRow)! } : {}) };
        try {
          const out = await this.employees.create(input, (tx, employeeId) => this.assets.assignAtHire(tx, employeeId, p.assetIds, 'Recorded when the employee was imported'));
          created.set(p.result.row, out.employee.id);
          p.result.status = 'created';
          p.result.employeeId = out.employee.id;
        } catch (err) {
          p.result.status = 'error';
          p.result.errors.push(...errorsOf(err));
        }
      }
    }
    for (const p of pending) {
      p.result.status = 'error';
      p.result.errors.push({ column: LABEL.managerCode!, message: 'The reporting lines in the file go round in a circle' });
    }
    const result = summarise(false, prepared.map((p) => p.result), [...creates]);
    await this.db.tenant((tx) => this.audit.record(tx, { action: 'employee.imported', resourceType: 'employee', resourceId: null, changes: { summary: result.summary }, metadata: { fileName: file?.originalname ?? null } }));
    return result;
  }

  /** The sheet as rows of text: an Excel workbook or a CSV file (UTF-8). */
  private read(file: UploadedFile | undefined): string[][] {
    if (!file?.buffer?.length) throw Errors.badRequest('file_required', 'Choose the filled-in template (Excel or CSV)');
    if (file.size > IMPORT_MAX_BYTES) throw Errors.badRequest('file_too_large', 'The file is over 5 MB. Split it into smaller files.');
    const zip = file.buffer[0] === 0x50 && file.buffer[1] === 0x4b;
    let rows: string[][];
    if (zip) {
      try {
        rows = readXlsx(file.buffer, IMPORT_MAX_ROWS + 10);
      } catch {
        throw Errors.badRequest('unreadable_file', 'This file could not be read as an Excel workbook. Save it as .xlsx or CSV and try again.');
      }
    } else {
      const text = file.buffer.toString('utf8');
      if (text.includes('\u0000')) throw Errors.badRequest('unreadable_file', 'Upload the template as an Excel workbook (.xlsx) or a CSV file');
      rows = parseCsv(text);
    }
    return rows.filter((r) => r.some((c) => c.trim() !== ''));
  }

  private async prepare(tx: TenantTx, rows: string[][]): Promise<Prepared[]> {
    const [headerRow = [], ...body] = rows;
    const keys = headerRow.map((h) => importHeaderKey(h));
    const missing = EMPLOYEE_IMPORT_COLUMNS.filter((c) => c.required && !keys.includes(c.key)).map((c) => c.label);
    if (missing.length) throw Errors.badRequest('missing_columns', `The file has no ${missing.join(', ')} column. Start from the template.`);
    if (body.length > IMPORT_MAX_ROWS) throw Errors.badRequest('too_many_rows', `Import up to ${IMPORT_MAX_ROWS} people at a time`);
    if (!body.length) throw Errors.badRequest('no_rows', 'The file has no people in it');

    const entities = await tx.collection('legal_entities').find({ archived_at: null });
    const departments = await tx.collection('departments').find({ archived_at: null });
    const locations = await tx.collection('locations').find({ archived_at: null });
    const designations = await tx.collection('designations').find({ archived_at: null }, { projection: { name: 1 } });
    const leaveTypes = new Map((await tx.collection('leave_types').find({ archived_at: null })).map((t) => [String(t.code).toUpperCase(), t]));
    const people = await tx.collection('employees').find({}, { projection: { employee_code: 1, work_email: 1, personal_email: 1, phone: 1, status: 1, first_name: 1, last_name: 1 } });
    const byCode = new Map(people.map((e) => [lc(e.employee_code), e]));
    const unknownLeave = keys.flatMap((k, i) => (k?.startsWith('leave:') && !leaveTypes.has(k.slice(6)) ? [headerRow[i]!.trim()] : []));

    const seen = { code: new Map<string, number>(), email: new Map<string, number>(), asset: new Map<string, number>() };
    const fileCodes = new Map<string, number>();
    body.forEach((r, i) => {
      const c = r[keys.indexOf('employeeCode')]?.trim();
      if (c) fileCodes.set(lc(c), i + 2);
    });

    const out: Prepared[] = [];
    for (let i = 0; i < body.length; i++) {
      const r = body[i]!;
      const rowNo = i + 2;
      const cell = (k: EmployeeImportColumn) => {
        const at = keys.indexOf(k);
        return at < 0 ? '' : String(r[at] ?? '').trim();
      };
      const errors: ImportRowResult['errors'] = [];
      const warnings: string[] = [];
      const err = (k: string, message: string) => errors.push({ column: LABEL[k] ?? k, message });
      const code = cell('employeeCode');
      const firstName = cell('firstName');
      const result: ImportRowResult = { row: rowNo, employeeCode: code || null, name: [firstName, cell('lastName')].filter(Boolean).join(' ') || null, status: 'ok', errors, warnings };
      const p: Prepared = { result, assetIds: [] };
      out.push(p);
      for (const h of unknownLeave) warnings.push(`No leave type with the code in "${h}": that column is ignored`);
      // Required columns are reported with every other problem on the row, so one check shows all that needs fixing.
      if (!code) err('employeeCode', 'Enter the employee ID');
      if (!firstName) err('firstName', 'Enter the first name');

      // Duplicates: the same person already in SampCrew, or twice in this file.
      if (code) {
        const dup = byCode.get(lc(code));
        if (dup) {
          result.status = 'duplicate';
          err('employeeCode', `${code} is already ${dup.first_name} ${dup.last_name ?? ''}`.trim() + ' in SampCrew');
          continue;
        }
        const first = seen.code.get(lc(code));
        if (first) err('employeeCode', `${code} is also on row ${first}`);
        else seen.code.set(lc(code), rowNo);
      }
      for (const k of ['workEmail', 'personalEmail'] as const) {
        const v = lc(cell(k));
        if (!v) continue;
        const dup = people.find((e) => e.status !== 'exited' && (lc(e.work_email) === v || lc(e.personal_email) === v));
        if (dup) {
          result.status = 'duplicate';
          err(k, `${cell(k)} already belongs to ${dup.first_name} ${dup.last_name ?? ''}`.trim() + ` (${dup.employee_code})`);
        }
        const first = seen.email.get(v);
        if (first) err(k, `${cell(k)} is also on row ${first}`);
        else seen.email.set(v, rowNo);
      }
      if (result.status === 'duplicate') continue;
      const phoneDigits = digitsOf(cell('phone'));
      if (phoneDigits.length >= 7) {
        const dup = people.find((e) => e.status !== 'exited' && digitsOf(e.phone).slice(-10) === phoneDigits.slice(-10));
        if (dup) warnings.push(`The phone number is also ${dup.first_name} ${dup.last_name ?? ''}`.trim() + `'s (${dup.employee_code})`);
      }

      // Placement.
      let entity: Doc | undefined;
      const entityName = cell('legalEntity');
      if (entityName) {
        entity = entities.find((e) => lc(e.name) === lc(entityName) || lc(e.legal_name) === lc(entityName));
        if (!entity) err('legalEntity', `No legal entity called ${entityName}`);
      } else if (entities.length === 1) entity = entities[0];
      else err('legalEntity', 'Say which legal entity they work for');
      const inEntity = (d: Doc) => !entity || !d.legal_entity_id || d.legal_entity_id === entity.id;
      const deptName = cell('department');
      const dept = deptName ? departments.find((d) => inEntity(d) && (lc(d.name) === lc(deptName) || (d.code && lc(d.code) === lc(deptName)))) : undefined;
      if (deptName && !dept) err('department', `No department called ${deptName}${entity ? ` in ${entity.name}` : ''}. Add it in Organisation first.`);
      const locName = cell('location');
      const loc = locName ? locations.find((d) => inEntity(d) && (lc(d.name) === lc(locName) || (d.code && lc(d.code) === lc(locName)))) : undefined;
      if (locName && !loc) err('location', `No location called ${locName}${entity ? ` in ${entity.name}` : ''}. Add it in Organisation first.`);
      const desName = cell('designation').replace(/\s+/g, ' ');
      const des = desName ? designations.find((d) => lc(d.name) === lc(desName)) : undefined;

      // The reporting manager: someone in SampCrew, or another row of this file.
      let managerEmployeeId: string | undefined;
      const mgrCode = cell('managerCode');
      if (mgrCode) {
        if (lc(mgrCode) === lc(code)) err('managerCode', 'Someone cannot report to themselves');
        else {
          const m = byCode.get(lc(mgrCode));
          if (m && m.status === 'exited') err('managerCode', `${mgrCode} has left the organisation`);
          else if (m) managerEmployeeId = m.id as string;
          else if (fileCodes.has(lc(mgrCode))) p.managerRow = fileCodes.get(lc(mgrCode));
          else err('managerCode', `No employee with the ID ${mgrCode}, here or in the file`);
        }
      }

      const date = (k: EmployeeImportColumn) => {
        const v = cell(k);
        if (!v) return undefined;
        const d = parseSheetDate(v);
        if (!d) err(k, `${v} is not a date. Use 2021-04-05 or 05/04/2021 (day first).`);
        return d ?? undefined;
      };
      const dateOfJoining = date('dateOfJoining');
      const dateOfBirth = date('dateOfBirth');
      const confirmationDate = date('confirmationDate');
      if (dateOfJoining && dateOfJoining > today()) warnings.push('The joining date is in the future: they are added as pre-boarding');

      const typeText = cell('employmentType');
      const employmentType = typeText ? EMPLOYMENT_TYPES.find((t) => t === slug(typeText) || t.replace('_', '') === slug(typeText).replace(/_/g, '')) : 'full_time';
      if (!employmentType) err('employmentType', `Use one of: ${EMPLOYMENT_TYPES.join(', ')}`);
      const genderText = cell('gender');
      const gender = genderText ? GENDERS.find((g) => g === slug(genderText) || g[0] === slug(genderText) && slug(genderText).length === 1) : undefined;
      if (genderText && !gender) err('gender', `Use one of: ${GENDERS.join(', ')}`);

      const phone = cell('phone');
      if (phone && entity) {
        const bad = phoneError(phone, (entity.country_code as string | undefined) ?? null);
        if (bad) err('phone', bad);
      }

      // Leave they have available today, per leave type.
      const openingLeaveBalances: { leaveTypeId: string; days: string }[] = [];
      keys.forEach((k, at) => {
        if (!k?.startsWith('leave:')) return;
        const t = leaveTypes.get(k.slice(6));
        const v = String(r[at] ?? '').trim();
        if (!t || !v) return;
        if (!/^-?\d{1,3}(\.\d{1,2})?$/.test(v)) errors.push({ column: headerRow[at]!.trim(), message: `${v} is not a number of days` });
        else openingLeaveBalances.push({ leaveTypeId: t.id as string, days: v });
      });

      // Assets they hold.
      const codes = cell('assetCodes').split(/[;,\n]+/).map((s) => s.trim()).filter(Boolean);
      for (const c of codes) {
        const a = await tx.collection('assets').findOne({ asset_code: c.toLowerCase() });
        if (!a) err('assetCodes', `No asset ${c.toUpperCase()}`);
        else if (a.status !== 'available') err('assetCodes', `${c.toUpperCase()} is not available (it is ${String(a.status).replace(/_/g, ' ')})`);
        else if (seen.asset.has(a.id)) err('assetCodes', `${c.toUpperCase()} is also on row ${seen.asset.get(a.id)}`);
        else {
          seen.asset.set(a.id, rowNo);
          p.assetIds.push(a.id as string);
        }
      }

      if (errors.length) {
        result.status = 'error';
        continue;
      }
      const parsed = createEmployeeInput.safeParse({
        joinedAs: 'existing',
        employeeCode: code,
        firstName,
        lastName: cell('lastName'),
        workEmail: cell('workEmail') || undefined,
        personalEmail: cell('personalEmail') || undefined,
        phone: phone || undefined,
        dateOfBirth,
        gender,
        dateOfJoining,
        confirmationDate,
        employmentType,
        legalEntityId: entity!.id,
        departmentId: dept?.id ?? null,
        locationId: loc?.id ?? null,
        ...(des ? { designationId: des.id } : desName ? { designationName: desName } : {}),
        ...(managerEmployeeId ? { managerEmployeeId } : {}),
        ...(openingLeaveBalances.length ? { openingLeaveBalances } : {}),
        loginMode: 'none',
      });
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const k = PATH_COLUMN[String(issue.path[0] ?? '')] ?? String(issue.path[0] ?? 'row');
          errors.push({ column: k === 'leave' ? 'Leave' : (LABEL[k] ?? k), message: issue.message });
        }
        result.status = 'error';
        continue;
      }
      p.input = parsed.data;
      if (!des && desName) warnings.push(`The designation ${desName} is new and will be added`);
    }
    return out;
  }
}

function errorsOf(err: unknown): ImportRowResult['errors'] {
  if (err instanceof AppError) {
    const details = err.details as { path: string; message: string }[] | undefined;
    if (Array.isArray(details) && details.length) return details.map((d) => ({ column: LABEL[PATH_COLUMN[String(d.path).split('.')[0]!] ?? ''] ?? d.path, message: d.message }));
    return [{ column: 'Row', message: err.message }];
  }
  return [{ column: 'Row', message: 'This row could not be added. Try again, or add the person from the hire form.' }];
}

function summarise(dryRun: boolean, rows: ImportRowResult[], designations: string[]): ImportResult {
  return {
    dryRun,
    rows,
    summary: {
      total: rows.length,
      ok: rows.filter((r) => r.status === 'ok').length,
      errors: rows.filter((r) => r.status === 'error').length,
      duplicates: rows.filter((r) => r.status === 'duplicate').length,
      created: rows.filter((r) => r.status === 'created').length,
    },
    creates: { designations },
  };
}
