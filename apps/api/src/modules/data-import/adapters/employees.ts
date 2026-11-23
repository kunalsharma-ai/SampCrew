import {
  BLOOD_GROUPS,
  CHOICE_ALIASES,
  createEmployeeInput,
  type CreateEmployeeInput,
  EMPLOYEE_IMPORT_FIELDS,
  employeeCodeInput,
  EMPLOYMENT_TYPES,
  GENDERS,
  type ImportField,
  LEAVE_FIELD_PREFIX,
  MARITAL_STATUSES,
  parseSheetDate,
  phoneError,
  sheetChoice,
  sheetList,
} from '@crew/contracts';
import type { AuthzService } from '../../../platform/authz/authz.service';
import { grantsFor } from '../../../platform/authz/policy';
import type { MongoService as DatabaseService, TenantTx } from '../../../platform/database/mongo.service';
import type { AssetsService } from '../../assets/assets.service';
import { EMPLOYEE_FIELDS } from '../../employees/employee-attrs';
import type { EmployeesService } from '../../employees/employees.service';
import type { ProfileService } from '../../employees/profile.service';
import { listValue } from './lists';
import { type Checked, type Doc, digits, type ImportAdapter, issue, lc, type ListNeed, type Lookups, type MappedRow, nameParts, phoneKey, sameInFile } from './types';

interface Person { id: string; code: string; label: string; status: string; visible: boolean; workEmail: string | null; personalEmail: string | null; phone: string | null }

interface EmployeeLookups extends Lookups {
  entities: Doc[];
  departments: Doc[];
  byCode: Map<string, Person>;
  byWorkEmail: Map<string, Person>;
  byPersonalEmail: Map<string, Person>;
  byPhone: Map<string, Person[]>;
  leaveTypes: Map<string, Doc>;
  hrWorkspaces: Doc[];
  companyWide: boolean;
  mayChangeJob: boolean;
  maySetLeave: boolean;
  assets: Map<string, Doc>;
  /** Current job details of matched people, for updates. */
  jobs: Map<string, Doc>;
}

const today = () => new Date().toISOString().slice(0, 10);
const PLACEMENT = ['department', 'designation', 'location', 'managerCode', 'employmentType', 'grade'] as const;

export function employeeAdapter(deps: { db: DatabaseService; authz: AuthzService; employees: EmployeesService; profile: ProfileService; assets: AssetsService }): ImportAdapter<EmployeeLookups> {
  return {
    type: 'employees',
    indexFields: ['employeeCode', 'workEmail', 'personalEmail', 'phone', 'assetCodes'],
    fields: () => EMPLOYEE_IMPORT_FIELDS,
    href: (id) => `/employees/${id}`,

    async load(tx: TenantTx, _options, base) {
      const s = await deps.authz.subject(tx);
      const visibleFilter = await deps.authz.filter('employees:read', EMPLOYEE_FIELDS, tx);
      const visible = new Set((await tx.collection('employees').find(visibleFilter, { projection: { _id: 1 } })).map((e) => e.id as string));
      const people = await tx.collection('employees').find({ erased_at: null }, { projection: { employee_code: 1, work_email: 1, personal_email: 1, phone: 1, status: 1, first_name: 1, last_name: 1 } });
      const lk: EmployeeLookups = {
        ...base,
        entities: await tx.collection('legal_entities').find({ archived_at: null }),
        departments: await tx.collection('departments').find({}, { projection: { name: 1, code: 1, legal_entity_id: 1, archived_at: 1 } }),
        byCode: new Map(), byWorkEmail: new Map(), byPersonalEmail: new Map(), byPhone: new Map(),
        leaveTypes: new Map((await tx.collection('leave_types').find({ archived_at: null })).map((t) => [String(t.code).toUpperCase(), t])),
        hrWorkspaces: await tx.collection('hr_workspaces').find({ status: 'active' }, { projection: { name: 1, code: 1 } }),
        companyWide: grantsFor(s, 'employees:create').some((g) => !g.constraints.hrWorkspaceIds?.length),
        mayChangeJob: grantsFor(s, 'employees:lifecycle').length > 0,
        maySetLeave: grantsFor(s, 'leave:approve').length > 0,
        assets: new Map((await tx.collection('assets').find({ archived_at: null }, { projection: { asset_code: 1, status: 1, name: 1 } })).map((a) => [lc(a.asset_code), a])),
        jobs: new Map(),
      };
      for (const e of people) {
        const p: Person = {
          id: e.id, code: e.employee_code, label: `${e.first_name} ${e.last_name ?? ''}`.trim() + ` (${e.employee_code})`, status: e.status, visible: visible.has(e.id),
          workEmail: e.work_email ?? null, personalEmail: e.personal_email ?? null, phone: e.phone ?? null,
        };
        lk.byCode.set(lc(e.employee_code), p);
        if (e.status !== 'exited') {
          if (e.work_email) lk.byWorkEmail.set(lc(e.work_email), p);
          if (e.personal_email) lk.byPersonalEmail.set(lc(e.personal_email), p);
          if (digits(e.phone).length >= 7) lk.byPhone.set(phoneKey(e.phone), [...(lk.byPhone.get(phoneKey(e.phone)) ?? []), p]);
        }
      }
      const visibleIds = [...visible];
      for (let i = 0; i < visibleIds.length; i += 2000) {
        for (const e of await tx.collection('employees').find({ id: { $in: visibleIds.slice(i, i + 2000) } }, { projection: { current_department_id: 1, current_location_id: 1, current_designation_id: 1, current_manager_employee_id: 1, employment_type: 1, current_grade: 1, current_legal_entity_id: 1, date_of_joining: 1 } })) lk.jobs.set(e.id, e);
      }
      return lk;
    },

    check(r: MappedRow, lk, file, options): Checked {
      const v = r.values;
      const c: Checked = { issues: [], label: null, match: null, uniqueMatch: false, after: [], data: {} };
      const err = (f: string, m: string, s?: string) => c.issues.push(issue(r, f, 'error', m, s));
      const warn = (f: string, m: string, s?: string) => c.issues.push(issue(r, f, 'warning', m, s));
      const needs: ListNeed[] = [];
      const { first, last } = nameParts(v);
      const code = v.employeeCode ?? '';
      c.label = [first, last].filter(Boolean).join(' ') || code || null;
      if (!first) err(v.fullName !== undefined ? 'fullName' : 'firstName', 'Enter the name', 'Fill in the first name or full name');

      // The existing record this row is about, by the fields chosen, in order.
      const finders: Record<string, () => Person | undefined> = {
        employeeCode: () => (code ? lk.byCode.get(lc(code)) : undefined),
        workEmail: () => (v.workEmail ? lk.byWorkEmail.get(lc(v.workEmail)) : undefined),
        personalEmail: () => (v.personalEmail ? lk.byPersonalEmail.get(lc(v.personalEmail)) : undefined),
        phone: () => { const list = v.phone && digits(v.phone).length >= 7 ? lk.byPhone.get(phoneKey(v.phone)) : undefined; return list?.length === 1 ? list[0] : undefined; },
      };
      for (const by of options.matchBy) {
        const p = finders[by]?.();
        if (!p) continue;
        if (!p.visible) {
          if (by === 'employeeCode' || by === 'workEmail') err(by, `${v[by]} already belongs to someone you cannot see`, 'Use another value, or ask the Super Workspace');
          continue;
        }
        if (p.status === 'exited' && by !== 'employeeCode') continue;
        c.match = { recordId: p.id, label: p.label, by };
        c.uniqueMatch = by === 'employeeCode' || by === 'workEmail';
        break;
      }
      // Unique values that belong to someone else (not the matched person) can never be used.
      const owner = (p: Person | undefined) => p && p.id !== c.match?.recordId;
      if (code) {
        const bad = employeeCodeInput.safeParse(code);
        if (!bad.success) err('employeeCode', `${code}: ${bad.error.issues[0]?.message ?? 'not a valid employee ID'}`);
        const p = lk.byCode.get(lc(code));
        if (owner(p)) err('employeeCode', p!.visible ? `${code} is already ${p!.label}` : `${code} already belongs to someone you cannot see`, 'Use another employee ID, or match by employee ID to update them');
        const twin = sameInFile(file, 'employeeCode', lc(code), r.row);
        if (twin.length) err('employeeCode', `${code} is also on row ${twin[0]}`, 'Each employee ID can appear once');
      }
      for (const f of ['workEmail', 'personalEmail'] as const) {
        const e = v[f];
        if (!e) continue;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) { err(f, `${e} is not an email address`); continue; }
        const twin = sameInFile(file, f, lc(e), r.row);
        if (twin.length) err(f, `${e} is also on row ${twin[0]}`);
        const p = f === 'workEmail' ? lk.byWorkEmail.get(lc(e)) : lk.byPersonalEmail.get(lc(e));
        if (f === 'workEmail' && owner(p)) err(f, p!.visible ? `${e} already belongs to ${p!.label}` : `${e} already belongs to someone you cannot see`);
        if (f === 'personalEmail' && owner(p) && p!.visible) warn(f, `${p!.label} has the same personal email`);
      }
      if (v.workEmail && v.personalEmail && lc(v.workEmail) === lc(v.personalEmail)) err('personalEmail', 'The personal email must differ from the work email');
      if (v.phone && digits(v.phone).length >= 7) {
        const same = (lk.byPhone.get(phoneKey(v.phone)) ?? []).filter((p) => p.id !== c.match?.recordId && p.visible);
        if (same.length) warn('phone', `${same[0]!.label} has the same phone number`);
      }

      const updating = !!c.match;
      const job = c.match ? lk.jobs.get(c.match.recordId) : undefined;

      // Legal entity, department, location, job title.
      let entity: Doc | undefined;
      if (v.legalEntity) {
        entity = lk.entities.find((e) => lc(e.name) === lc(v.legalEntity) || lc(e.legal_name) === lc(v.legalEntity));
        if (!entity) err('legalEntity', `No legal entity called ${v.legalEntity}`, `Use one of: ${lk.entities.map((e) => e.name).join(', ')}`);
      } else if (job) entity = lk.entities.find((e) => e.id === job.current_legal_entity_id);
      else if (lk.entities.length === 1) entity = lk.entities[0];
      else err('legalEntity', 'Say which legal entity they work for', `Add a Legal entity column with one of: ${lk.entities.map((e) => e.name).join(', ')}`);
      const dept = listValue(r, 'department', 'department', lk, c, needs);
      if (dept && dept !== 'new' && entity) {
        const raw = lk.departments.find((d) => d.id === dept.id);
        if (raw?.legal_entity_id && raw.legal_entity_id !== entity.id) err('department', `${dept.label} belongs to another legal entity`);
      }
      const loc = listValue(r, 'location', 'location', { ...lk, mayAdd: new Set() }, c, needs);
      const desText = (v.designation ?? '').replace(/\s+/g, ' ').trim();
      const des = desText ? (lk.lists.get('job_title') ?? []).find((d) => lc(d.label) === lc(desText)) : undefined;
      if (des?.disabled) err('designation', `${des.label} is disabled in job titles`, 'Enable it in Settings > Master data, or use another title');
      else if (desText && !des) warn('designation', `${desText} is a new job title and will be added`);

      // Reporting manager: someone in SampCrew, or another row of this file.
      let managerEmployeeId: string | undefined;
      let managerRow: number | undefined;
      if (v.managerCode) {
        if (lc(v.managerCode) === lc(code)) err('managerCode', 'Someone cannot report to themselves');
        else {
          const m = lk.byCode.get(lc(v.managerCode));
          const inFile = file.get('employeeCode')?.get(lc(v.managerCode))?.[0];
          if (m && m.status === 'exited') err('managerCode', `${v.managerCode} has left the organisation`);
          else if (m && !m.visible) err('managerCode', `${v.managerCode} is someone you cannot see`);
          else if (m) managerEmployeeId = m.id;
          else if (inFile) { managerRow = inFile; c.after.push(inFile); } else err('managerCode', `No employee with the ID ${v.managerCode}, in SampCrew or in this file`, 'Add their manager to the file, or leave the cell empty');
        }
      }

      // Dates and choices.
      const date = (f: string) => {
        if (!v[f]) return undefined;
        const d = parseSheetDate(v[f]!);
        if (!d) err(f, `${v[f]} is not a date`, 'Use 2021-04-05 or 05/04/2021 (day first)');
        return d ?? undefined;
      };
      const dateOfJoining = date('dateOfJoining');
      const dateOfBirth = date('dateOfBirth');
      const confirmationDate = date('confirmationDate');
      if (!updating && !v.dateOfJoining) err('dateOfJoining', 'Enter the date of joining');
      if (dateOfJoining && dateOfJoining > today() && !updating) warn('dateOfJoining', 'The joining date is in the future: they are added as pre-boarding');
      if (updating && dateOfJoining && job && job.date_of_joining !== dateOfJoining) warn('dateOfJoining', `The joining date in SampCrew (${job.date_of_joining}) is kept`);
      const choice = <T extends string>(f: string, list: readonly T[]) => {
        if (!v[f]) return undefined;
        const hit = sheetChoice(v[f]!, list, (CHOICE_ALIASES[f] ?? {}) as Record<string, T>);
        if (!hit) err(f, `${v[f]} is not a ${f === 'employmentType' ? 'type of employment' : f.replace(/([A-Z])/g, ' $1').toLowerCase()} SampCrew knows`, `Use one of: ${list.join(', ')}`);
        return hit ?? undefined;
      };
      const employmentType = choice('employmentType', EMPLOYMENT_TYPES);
      const gender = choice('gender', GENDERS);
      const maritalStatus = choice('maritalStatus', MARITAL_STATUSES);
      const bloodGroup = v.bloodGroup ? (BLOOD_GROUPS.find((b) => b.toLowerCase() === v.bloodGroup!.replace(/\s+/g, '').replace(/ve$/i, '').replace(/positive$/i, '+').replace(/negative$/i, '-').toLowerCase()) ?? undefined) : undefined;
      if (v.bloodGroup && !bloodGroup) err('bloodGroup', `${v.bloodGroup} is not a blood group`, `Use one of: ${BLOOD_GROUPS.join(', ')}`);
      if (v.phone && entity) {
        const bad = phoneError(v.phone, entity.country_code ?? null);
        if (bad) err('phone', bad);
      }
      if (v.emergencyPhone && entity) {
        const bad = phoneError(v.emergencyPhone, entity.country_code ?? null);
        if (bad) err('emergencyPhone', bad);
      }

      // HR Workspace from the file: the Super Workspace only.
      let hrWorkspaceId: string | null | undefined = options.hrWorkspaceId;
      if (v.hrWorkspace) {
        if (!lk.companyWide) err('hrWorkspace', 'Only the Super Workspace can place people in an HR Workspace from the file', 'Leave the column empty or unmapped');
        else if (updating) warn('hrWorkspace', 'Moving someone to another HR Workspace is done from the HR Workspace page; the column is ignored for updates');
        else {
          const w = lk.hrWorkspaces.find((x) => lc(x.name) === lc(v.hrWorkspace) || (x.code && lc(x.code) === lc(v.hrWorkspace)));
          if (!w) err('hrWorkspace', `No active HR Workspace called ${v.hrWorkspace}`, `Use one of: ${lk.hrWorkspaces.map((x) => x.name).join(', ')}`);
          else hrWorkspaceId = w.id;
        }
      }

      // Leave available today, per leave type (new people only).
      const openingLeaveBalances: { leaveTypeId: string; days: string }[] = [];
      for (const [f, val] of Object.entries(v)) {
        if (!f.startsWith(LEAVE_FIELD_PREFIX) || !val) continue;
        const t = lk.leaveTypes.get(f.slice(LEAVE_FIELD_PREFIX.length).toUpperCase());
        if (!t) continue;
        if (!/^-?\d{1,3}(\.\d{1,2})?$/.test(val)) err(f, `${val} is not a number of days`, 'Use a number such as 12 or 7.5');
        else openingLeaveBalances.push({ leaveTypeId: t.id, days: val });
      }
      if (openingLeaveBalances.length && updating) warn(Object.keys(v).find((k) => k.startsWith(LEAVE_FIELD_PREFIX))!, 'Leave balances are set only for new people: adjust balances from Leave');
      if (openingLeaveBalances.length && !updating && !lk.maySetLeave) warn(Object.keys(v).find((k) => k.startsWith(LEAVE_FIELD_PREFIX))!, 'Leave balances are not imported: you cannot set leave balances');

      // Assets they hold.
      const assetIds: string[] = [];
      for (const a of sheetList(v.assetCodes ?? '')) {
        const found = lk.assets.get(lc(a));
        if (!found) err('assetCodes', `No asset ${a.toUpperCase()}`);
        else if (found.status !== 'available') err('assetCodes', `${a.toUpperCase()} is not available (it is ${String(found.status).replace(/_/g, ' ')})`);
        else if (sameInFile(file, 'assetCodes', lc(a), r.row).length) err('assetCodes', `${a.toUpperCase()} is also on row ${sameInFile(file, 'assetCodes', lc(a), r.row)[0]}`);
        else assetIds.push(found.id);
      }
      if (assetIds.length && updating) warn('assetCodes', 'Assets are handed over only to new people: assign them from Assets');

      // Education and skills from master data.
      const qual = listValue(r, 'highestQualification', 'education', lk, c, needs);
      const skills: string[] = [];
      for (const s of sheetList(v.skills ?? '')) {
        const hit = listValue(r, 'skills', 'skill', lk, c, needs, s);
        if (hit === 'new') skills.push(s);
        else if (hit) skills.push(hit.label);
      }

      // Profile sections (merged with what the record already has).
      const profile: Doc = {};
      if (v.nationality || maritalStatus || bloodGroup) profile.personal = { ...(v.nationality ? { nationality: v.nationality } : {}), ...(maritalStatus ? { maritalStatus } : {}), ...(bloodGroup ? { bloodGroup } : {}) };
      const addr = { line1: v.addressLine1, line2: v.addressLine2, city: v.city, state: v.state, postalCode: v.postalCode, country: v.country };
      if (Object.values(addr).some(Boolean)) profile.address = { current: Object.fromEntries(Object.entries(addr).filter(([, x]) => x)) };
      if (v.emergencyName || v.emergencyPhone || v.emergencyRelationship) {
        const missing = [!v.emergencyName && 'name', !v.emergencyRelationship && 'relationship', !v.emergencyPhone && 'phone'].filter(Boolean);
        if (missing.length) err(v.emergencyName ? (v.emergencyRelationship ? 'emergencyPhone' : 'emergencyRelationship') : 'emergencyName', `The emergency contact needs a ${missing.join(' and ')}`);
        else profile.emergency = { contacts: [{ name: v.emergencyName, relationship: v.emergencyRelationship, phone: v.emergencyPhone, email: null }] };
      }
      if (qual) profile.education = { highestQualification: qual === 'new' ? v.highestQualification : qual.label };
      if (skills.length) profile.skills = { skills };
      if (v.addressLine1 && v.addressLine1.length > 200) err('addressLine1', 'The address is longer than 200 characters');
      if (v.postalCode && v.postalCode.length > 12) err('postalCode', 'The postal code is longer than 12 characters');

      const placement: Doc = {
        departmentId: dept === 'new' ? 'new' : dept?.id,
        locationId: loc && loc !== 'new' ? loc.id : undefined,
        designationId: des?.id,
        designationName: !des && desText ? desText : undefined,
        managerEmployeeId,
        managerRow,
        employmentType,
        grade: v.grade || undefined,
      };
      c.data = { needs, profile, assetIds, placement, entityId: entity?.id, openingLeaveBalances: lk.maySetLeave ? openingLeaveBalances : [] };

      if (updating) {
        const personal: Doc = {};
        if (first) personal.firstName = first;
        if (last) personal.lastName = last;
        if (v.preferredName) personal.preferredName = v.preferredName;
        if (v.workEmail) personal.workEmail = v.workEmail.toLowerCase();
        if (v.personalEmail) personal.personalEmail = v.personalEmail.toLowerCase();
        if (v.phone) personal.phone = v.phone;
        if (dateOfBirth) personal.dateOfBirth = dateOfBirth;
        if (gender) personal.gender = gender;
        c.data.personal = personal;
        const changes = job ? PLACEMENT.filter((f) => {
          if (!v[f]) return false;
          if (f === 'department') return placement.departmentId !== job.current_department_id;
          if (f === 'location') return placement.locationId !== job.current_location_id;
          if (f === 'designation') return placement.designationName !== undefined || placement.designationId !== job.current_designation_id;
          if (f === 'managerCode') return (managerEmployeeId ?? managerRow) !== job.current_manager_employee_id;
          if (f === 'employmentType') return employmentType !== job.employment_type;
          return (v.grade ?? null) !== (job.current_grade ?? null);
        }) : [];
        if (changes.length && !lk.mayChangeJob) warn(changes[0]!, 'Job details are not changed: you cannot make job changes', 'Ask someone who can transfer or promote people');
        c.data.jobChanges = lk.mayChangeJob ? changes : [];
        return c;
      }

      // A new person: the same checks as the hire form.
      if (!c.issues.some((i) => i.level === 'error')) {
        const probe = createEmployeeInput.safeParse(hireInput(c, r, first, last, { dateOfJoining, dateOfBirth, confirmationDate, gender, hrWorkspaceId, probeIds: true }));
        if (!probe.success) {
          for (const i of probe.error.issues) {
            const f = String(i.path[0] ?? 'row');
            if (f === 'minorConfirmed') { err('dateOfBirth', i.message, 'Add people who were under 18 when they joined from the hire form, where you confirm the paperwork'); continue; }
            const field = ({ designationName: 'designation', departmentId: 'department', locationId: 'location', managerEmployeeId: 'managerCode', openingLeaveBalances: 'leave' } as Record<string, string>)[f] ?? f;
            err(field, i.message);
          }
        }
      }
      c.data.hire = { first, last, dateOfJoining, dateOfBirth, confirmationDate, gender, hrWorkspaceId };
      return c;
    },

    async write(c, r, action, lk, w, created) {
      const d = c.data;
      const added = await deps.db.tenant((tx) => w.ensureValues(tx, d.needs));
      const pick = (list: string, label: string | undefined) => (label ? added.get(`${list}:${label.toLowerCase()}`) : undefined);
      const placement = { ...d.placement } as Doc;
      if (placement.departmentId === 'new') placement.departmentId = pick('department', r.values.department)?.id;
      if (placement.managerRow !== undefined) {
        placement.managerEmployeeId = created.get(placement.managerRow);
        if (!placement.managerEmployeeId) throw Object.assign(new Error('manager_missing'), { importMessage: `Their manager (row ${placement.managerRow}) was not imported`, field: 'managerCode' });
      }
      const profileParts = { ...d.profile } as Doc;
      // Values added just now take the spelling stored in the list.
      if (profileParts.skills) profileParts.skills = { skills: (profileParts.skills.skills as string[]).map((s) => pick('skill', s)?.label ?? s) };

      if (action === 'update') {
        const id = c.match!.recordId;
        return deps.db.tenant(async (tx) => {
          if (Object.keys(d.personal).length) await deps.employees.updateIn(tx, id, d.personal);
          if (d.jobChanges.length) {
            const job: Doc = { effectiveFrom: today(), reason: 'correction', note: `Data import #${w.jobId.slice(0, 8)}` };
            for (const f of d.jobChanges as string[]) {
              if (f === 'department') job.departmentId = placement.departmentId ?? null;
              if (f === 'location') job.locationId = placement.locationId ?? null;
              if (f === 'designation') { if (placement.designationId) job.designationId = placement.designationId; else job.designationName = placement.designationName; }
              if (f === 'managerCode') job.managerEmployeeId = placement.managerEmployeeId ?? null;
              if (f === 'employmentType') job.employmentType = placement.employmentType;
              if (f === 'grade') job.grade = placement.grade ?? null;
            }
            if (job.designationName) {
              const des = await w.ensureValues(tx, [{ list: 'job_title', label: job.designationName }]);
              job.designationId = des.get(`job_title:${String(job.designationName).toLowerCase()}`)?.id;
              delete job.designationName;
            }
            await deps.employees.changeJobIn(tx, id, job as never);
          }
          await deps.profile.importSections(tx, id, profileParts);
          await w.saveCustom(tx, id, false);
          return { id, label: c.match!.label, action: 'updated' as const };
        });
      }

      const h = d.hire;
      const input = createEmployeeInput.parse(hireInput(c, r, h.first, h.last, { ...h, placement }));
      const out = await deps.employees.create(input, async (tx, employeeId) => {
        await tx.collection('employees').updateOne({ id: employeeId }, { $set: { source_import_id: w.jobId } });
        // The new person is now one of the importer's people: read their access again before the checks below.
        deps.authz.forget();
        if (d.assetIds.length) await deps.assets.assignAtHire(tx, employeeId, d.assetIds, 'Recorded when the employee was imported');
        await deps.profile.importSections(tx, employeeId, profileParts);
        await w.saveCustom(tx, employeeId, true);
      });
      const e = out.employee as Doc;
      lk.byCode.set(lc(e.employeeCode), { id: e.id, code: e.employeeCode, label: `${e.displayName} (${e.employeeCode})`, status: e.status, visible: true, workEmail: e.workEmail, personalEmail: e.personalEmail, phone: e.phone });
      return { id: e.id, label: `${e.displayName} (${e.employeeCode})`, action: 'imported' };
    },
  };
}

function hireInput(c: Checked, r: MappedRow, first: string, last: string, h: Doc): Partial<CreateEmployeeInput> & Doc {
  const v = r.values;
  const p = h.placement ?? c.data.placement;
  const probe = h.probeIds === true;
  const fake = '00000000-0000-4000-8000-000000000000';
  return {
    joinedAs: 'existing',
    ...(v.employeeCode ? { employeeCode: v.employeeCode } : {}),
    firstName: first,
    lastName: last,
    ...(v.preferredName ? { preferredName: v.preferredName } : {}),
    ...(v.workEmail ? { workEmail: v.workEmail.toLowerCase() } : {}),
    ...(v.personalEmail ? { personalEmail: v.personalEmail.toLowerCase() } : {}),
    ...(v.phone ? { phone: v.phone } : {}),
    ...(h.dateOfBirth ? { dateOfBirth: h.dateOfBirth } : {}),
    ...(h.gender ? { gender: h.gender } : {}),
    dateOfJoining: h.dateOfJoining,
    ...(h.confirmationDate ? { confirmationDate: h.confirmationDate } : {}),
    ...(p.employmentType ? { employmentType: p.employmentType } : {}),
    legalEntityId: c.data.entityId ?? fake,
    departmentId: p.departmentId === 'new' ? (probe ? fake : null) : (p.departmentId ?? null),
    locationId: p.locationId ?? null,
    ...(p.designationId ? { designationId: p.designationId } : p.designationName ? { designationName: p.designationName } : {}),
    ...(p.managerEmployeeId ? { managerEmployeeId: p.managerEmployeeId } : p.managerRow !== undefined && probe ? { managerEmployeeId: fake } : {}),
    ...(p.grade ? { grade: p.grade } : {}),
    ...(c.data.openingLeaveBalances?.length ? { openingLeaveBalances: c.data.openingLeaveBalances } : {}),
    ...(h.hrWorkspaceId !== undefined ? { hrWorkspaceId: h.hrWorkspaceId } : {}),
    probationMonths: 6,
    loginMode: 'none',
    onboardingTemplateId: null,
  };
}

export const employeeFieldsWithLeave = (fields: ImportField[], leaveTypes: Doc[]): ImportField[] => [
  ...fields,
  ...leaveTypes.map((t) => ({ key: `${LEAVE_FIELD_PREFIX}${String(t.code).toUpperCase()}`, label: `Leave balance: ${t.name as string} (${String(t.code).toUpperCase()})`, group: 'Leave balances today', kind: 'number' as const, synonyms: [`${t.code} balance`, `${t.name} balance`, `leave ${t.code}`, String(t.code), String(t.name)], help: 'Days available today' })),
];
