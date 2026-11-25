import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import {
  RECORD_DOCUMENTS, WORK_STATUS_LABEL, employeeRecordInput, pageAccessInput, recordScore,
  type EmployeeRecord, type EmployeeRecordInput, type PageAccessInput, type PageAccessView, type RecordItem, type WorkStatus,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { encryptField } from '../../platform/auth/crypto';
import { AuthzService } from '../../platform/authz/authz.service';
import { RequirePermission } from '../../platform/authz/decorators';
import { can } from '../../platform/authz/policy';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { employeeAttrsOf } from '../document-center/document-access';
import { pageAccessOf, setPageAccess } from './page-access';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
const filled = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== '';
const money = (n: number | null) => (n === null ? null : new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n));

/**
 * The employee record with its completion score (issue #86): every field and document HR keeps for the person,
 * done or pending, with where to fill each in. Reading needs employees:read for the person; changing the record's
 * own fields needs employees:update for someone else (HR keeps it; a person only reads their own); CTC figures need payroll:read or employees:sensitive:read.
 */
@Controller('employees/:id/record')
export class EmployeeRecordController {
  constructor(private readonly db: DatabaseService, private readonly authz: AuthzService, private readonly audit: AuditService, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get()
  @RequirePermission('employees:read')
  @Doc({ summary: 'The employee record: every field and document, done or pending, with the completion score' })
  get(@Param('id', UuidPipe) id: string): Promise<EmployeeRecord> {
    return this.db.tenant((tx) => this.view(tx, id));
  }

  @Put()
  @RequirePermission('employees:update')
  @Doc({ summary: "Change the employee record's own fields (family, gate pass, work status, CTC figures, notes)", body: employeeRecordInput })
  save(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(employeeRecordInput)) body: EmployeeRecordInput): Promise<EmployeeRecord> {
    return this.db.tenant(async (tx) => {
      const e = await this.employee(tx, id);
      await this.authz.require('employees:update', employeeAttrsOf(e), tx);
      const s = await this.authz.subject(tx);
      // The record is kept by HR: a person reads their own but does not fill it in.
      if (e.membership_id && e.membership_id === s.membershipId) throw Errors.forbidden('HR keeps the employee record; ask HR to change your own');
      const seePay = can(s, 'payroll:read', employeeAttrsOf(e)).allowed || can(s, 'employees:sensitive:read', employeeAttrsOf(e)).allowed;
      const pay = ['ctcAnnual', 'ctcAnnualInHand', 'ctcMonthlyFixed'] as const;
      if (!seePay && pay.some((k) => body[k] !== undefined)) throw Errors.forbidden('Only people who may see pay can change the CTC figures');
      const set: Row = { updated_by_membership_id: requestContext.tenantActor().membershipId };
      const map: [keyof EmployeeRecordInput, string][] = [
        ['fatherName', 'father_name'], ['motherName', 'mother_name'], ['parentsAddress', 'parents_address'], ['gatePassId', 'gate_pass_id'], ['workStatus', 'work_status'],
        ['ctcAnnual', 'ctc_annual'], ['ctcAnnualInHand', 'ctc_annual_in_hand'], ['ctcMonthlyFixed', 'ctc_monthly_fixed'], ['anyDetails', 'any_details'],
      ];
      for (const [k, col] of map) if (body[k] !== undefined) set[col] = body[k];
      if (body.parentAadhaar !== undefined) {
        set.parent_aadhaar_enc = body.parentAadhaar ? encryptField(body.parentAadhaar, this.config.fieldKeys) : null;
        set.parent_aadhaar_last4 = body.parentAadhaar ? body.parentAadhaar.slice(-4) : null;
      }
      await tx.collection('employee_record_details').upsert({ employee_id: id }, { employee_id: id, ...set }, { $set: set });
      const changed = Object.keys(body).filter((k) => body[k as keyof EmployeeRecordInput] !== undefined);
      await this.audit.record(tx, { action: 'employee.record_updated', resourceType: 'employee', resourceId: id, metadata: { fields: changed } });
      return this.view(tx, id);
    });
  }

  private async employee(tx: TenantTx, id: string) {
    const e = await tx.collection('employees').findOne({ id });
    if (!e) throw Errors.notFound('Employee');
    return e;
  }

  private async view(tx: TenantTx, id: string): Promise<EmployeeRecord> {
    const e = await this.employee(tx, id);
    const attrs = employeeAttrsOf(e);
    await this.authz.require('employees:read', attrs, tx);
    const s = await this.authz.subject(tx);
    const seePay = can(s, 'payroll:read', attrs).allowed || can(s, 'employees:sensitive:read', attrs).allowed;
    const mayEdit = can(s, 'employees:update', attrs).allowed && !(e.membership_id && e.membership_id === s.membershipId);
    const [rec, profile, sensitive, salary, docs, dept, desig] = await Promise.all([
      tx.collection('employee_record_details').findOne({ employee_id: id }),
      tx.collection('employee_profiles').findOne({ employee_id: id }),
      tx.collection('employee_sensitive').findOne({ employee_id: id }),
      tx.collection('employee_salaries').findOne({ employee_id: id }, { sort: { effective_from: -1 } }),
      tx.collection('employee_documents').find({ employee_id: id, archived_at: null, superseded_at: null }, { projection: { type_key: 1, category: 1, title: 1 } }),
      e.current_department_id ? tx.collection('departments').findOne({ id: e.current_department_id }, { projection: { name: 1 } }) : null,
      e.current_designation_id ? tx.collection('designations').findOne({ id: e.current_designation_id }, { projection: { name: 1 } }) : null,
    ]);
    const r = rec ?? {};
    const profileHref = `/profile/${id}`;
    const items: RecordItem[] = [];
    const add = (group: RecordItem['group'], key: string, label: string, value: unknown, href: string | null, optional = false, shown?: string | null) =>
      items.push({ key, label, group, done: filled(value), optional, value: filled(value) ? (shown === undefined ? String(value) : shown) : null, href });

    const legal = [e.first_name, e.middle_name, e.last_name].filter(filled).join(' ');
    add('identity', 'employee_code', 'Employee ID', e.employee_code, null);
    add('identity', 'name', 'Legal name', legal, `${profileHref}?tab=personal`);
    add('identity', 'gender', 'Gender', e.gender, `${profileHref}?tab=personal`, false, e.gender ? String(e.gender).replace(/_/g, ' ') : null);
    add('identity', 'date_of_birth', 'Date of birth', e.date_of_birth, `${profileHref}?tab=personal`);
    const address = profile?.address?.current;
    add('identity', 'address', 'Address', address?.line1, `${profileHref}?tab=address`, false, address ? [address.line1, address.line2, address.city, address.state, address.postalCode].filter(filled).join(', ') : null);
    add('job', 'date_of_joining', 'Date of joining', e.date_of_joining, null);
    add('job', 'last_working_day', 'Last working day', e.last_working_day, null, e.status !== 'exited' && e.status !== 'notice');
    add('job', 'department', 'Department', dept?.name, `/employees/${id}?tab=job`);
    add('job', 'designation', 'Designation', desig?.name, `/employees/${id}?tab=job`);
    add('job', 'work_status', 'Work status', r.work_status, null, false, r.work_status ? WORK_STATUS_LABEL[r.work_status as WorkStatus] : null);
    add('job', 'gate_pass_id', 'Gate pass ID', r.gate_pass_id, null);
    const ctc = num(r.ctc_annual) ?? num(salary?.annual_ctc);
    add('pay', 'ctc_annual', 'CTC (annual)', ctc, null, false, seePay ? money(ctc) : 'Recorded');
    add('pay', 'ctc_annual_in_hand', 'CTC annual in hand', num(r.ctc_annual_in_hand), null, false, seePay ? money(num(r.ctc_annual_in_hand)) : 'Recorded');
    add('pay', 'ctc_monthly_fixed', 'Monthly CTC (fixed)', num(r.ctc_monthly_fixed), null, false, seePay ? money(num(r.ctc_monthly_fixed)) : 'Recorded');
    add('contact', 'phone', 'Contact number', e.phone, `${profileHref}?tab=personal`);
    add('contact', 'personal_email', 'Personal email', e.personal_email, `${profileHref}?tab=personal`);
    add('contact', 'work_email', 'Professional email', e.work_email, null);
    add('family', 'father_name', 'Father name', r.father_name, null);
    add('family', 'mother_name', 'Mother name', r.mother_name, null);
    add('family', 'parent_aadhaar', 'Father / mother Aadhaar number', r.parent_aadhaar_last4, null, false, r.parent_aadhaar_last4 ? `XXXX XXXX ${r.parent_aadhaar_last4}` : null);
    add('family', 'parents_address', 'Father / mother address', r.parents_address, null);
    add('bank', 'account_holder', 'Name on bank account', sensitive?.account_holder_name, `${profileHref}?tab=bank`);
    add('bank', 'bank_name', 'Bank name', sensitive?.bank_name, `${profileHref}?tab=bank`);
    add('bank', 'bank_account', 'Bank account number', sensitive?.bank_account_enc, `${profileHref}?tab=bank`, false, 'Saved (encrypted)');
    add('bank', 'ifsc', 'IFSC code', sensitive?.bank_routing_enc, `${profileHref}?tab=bank`, false, 'Saved (encrypted)');
    const contact = (profile?.emergency?.contacts ?? [])[0] as { name?: string; phone?: string; relationship?: string } | undefined;
    add('emergency', 'emergency_name', 'Emergency contact name', contact?.name, `${profileHref}?tab=emergency`);
    add('emergency', 'emergency_phone', 'Emergency contact number', contact?.phone, `${profileHref}?tab=emergency`);
    add('emergency', 'emergency_relationship', 'Emergency contact relationship', contact?.relationship, `${profileHref}?tab=emergency`);
    const types = new Set(docs.map((d) => d.type_key).filter(Boolean));
    for (const d of RECORD_DOCUMENTS) {
      const hit = docs.find((x) => (d.types as readonly string[]).includes(x.type_key)) ?? (d.key === 'offer_letter' ? docs.find((x) => !x.type_key && x.category === 'offer_letter') : undefined);
      items.push({ key: `doc_${d.key}`, label: d.label, group: 'documents', done: Boolean(hit) || d.types.some((t) => types.has(t)), optional: 'optional' in d && Boolean(d.optional), value: hit ? String(hit.title) : null, href: `/employees/${id}?tab=documents` });
    }
    add('job', 'any_details', 'Any details', r.any_details, null, true);
    const { score, done, total } = recordScore(items);
    return {
      employeeId: id, score, done, total, items,
      values: {
        fatherName: r.father_name ?? null, motherName: r.mother_name ?? null, parentAadhaarMasked: r.parent_aadhaar_last4 ? `XXXX XXXX ${r.parent_aadhaar_last4}` : null,
        parentsAddress: r.parents_address ?? null, gatePassId: r.gate_pass_id ?? null, workStatus: (r.work_status as WorkStatus | undefined) ?? null,
        ctcAnnual: seePay ? num(r.ctc_annual) : null, ctcAnnualInHand: seePay ? num(r.ctc_annual_in_hand) : null, ctcMonthlyFixed: seePay ? num(r.ctc_monthly_fixed) : null,
        anyDetails: r.any_details ?? null,
      },
      can: { edit: mayEdit, seePay, uploadDocuments: can(s, 'documents:manage', attrs).allowed },
    };
  }
}

/**
 * Page access for one person (issue #86): the everyday pages their login opens, first chosen at registration. Reading
 * needs employees:read for the person; changing it needs modules:assign for them (HR Workspace admins of their HR
 * Workspace, or the Super Workspace).
 */
@Controller('employees/:id/page-access')
export class EmployeePageAccessController {
  constructor(private readonly db: DatabaseService, private readonly authz: AuthzService, private readonly audit: AuditService) {}

  @Get()
  @RequirePermission('employees:read')
  @Doc({ summary: 'The everyday pages this person’s login opens' })
  get(@Param('id', UuidPipe) id: string): Promise<PageAccessView> {
    return this.db.tenant(async (tx) => {
      const e = await tx.collection('employees').findOne({ id });
      if (!e) throw Errors.notFound('Employee');
      await this.authz.require('employees:read', employeeAttrsOf(e), tx);
      const s = await this.authz.subject(tx);
      return { pages: await pageAccessOf(tx, id), canEdit: can(s, 'modules:assign', employeeAttrsOf(e)).allowed };
    });
  }

  @Put()
  @RequirePermission('modules:assign')
  @Doc({ summary: 'Change the everyday pages this person’s login opens', body: pageAccessInput })
  save(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(pageAccessInput)) body: PageAccessInput): Promise<PageAccessView> {
    return this.db.tenant(async (tx) => {
      const e = await tx.collection('employees').findOne({ id });
      if (!e) throw Errors.notFound('Employee');
      await this.authz.require('modules:assign', employeeAttrsOf(e), tx);
      const before = await pageAccessOf(tx, id);
      if (!(await setPageAccess(tx, id, body.pages, requestContext.tenantActor().membershipId))) {
        throw Errors.badRequest('no_login', 'This person has no SampCrew login yet, so there are no pages to give. Invite them first.');
      }
      await this.audit.record(tx, { action: 'employee.page_access_set', resourceType: 'employee', resourceId: id, changes: { pages: { from: before, to: [...body.pages].sort() } } });
      return { pages: await pageAccessOf(tx, id), canEdit: true };
    });
  }
}
