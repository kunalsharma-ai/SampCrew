import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  ACCESS_LEVEL_LABEL,
  dateOfBirthError,
  EDUCATION_LEVEL_LABELS,
  mask,
  PROFILE_SECTION_LABELS,
  PROFILE_SECTION_SCHEMAS,
  PROFILE_SECTIONS,
  profileCompleteness,
  type ProfileSection,
  type profileChangeInput,
  type profileDecisionInput,
  SENSITIVE_SECTIONS,
} from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { decryptField, encryptField } from '../../platform/auth/crypto';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantCovers, grantsFor, type Subject } from '../../platform/authz/policy';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, membershipUserNames, type TenantTx } from '../../platform/database/mongo.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { EMPLOYEE_FIELDS, employeeAttrs } from './employee-attrs';
import { accessLevels, displayName, fieldById } from './employee-view';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
type Change = { field: string; label: string; old: string | null; new: string | null };

const OPEN = ['pending', 'info_requested'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

function attrsOf(e: Doc) {
  return employeeAttrs({ id: e.id, membershipId: e.membership_id ?? null, legalEntityId: e.current_legal_entity_id ?? null, departmentId: e.current_department_id ?? null, locationId: e.current_location_id ?? null });
}
function covers(s: Subject, permission: string, e: Doc) {
  const a = attrsOf(e);
  return grantsFor(s, permission).some((g) => grantCovers(s, g, a));
}

/** Field labels for the comparison HR sees. */
const LABELS: Record<string, string> = {
  firstName: 'First name', lastName: 'Last name', preferredName: 'Preferred name', dateOfBirth: 'Date of birth', gender: 'Gender', personalEmail: 'Personal email',
  phone: 'Personal phone', nationality: 'Nationality', maritalStatus: 'Marital status', bloodGroup: 'Blood group',
  accountHolderName: 'Account holder name', bankName: 'Bank name', accountNumber: 'Account number', ifsc: 'IFSC', branchName: 'Branch', accountType: 'Account type',
  aadhaar: 'Aadhaar number', pan: 'PAN', otherIdType: 'Other ID type', otherIdNumber: 'Other ID number', identityDocumentId: 'Identity document', addressProofDocumentId: 'Address proof',
  highestQualification: 'Highest qualification', totalExperienceMonths: 'Total experience (months)', skills: 'Skills', languages: 'Languages', certifications: 'Certifications',
};
/** Values that are masked whenever they are shown. */
const MASKED = new Set(['accountNumber', 'aadhaar', 'pan', 'otherIdNumber']);

const show = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  if (Array.isArray(v)) return v.length ? v.join(', ') : null;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
};
const addressLine = (a: Doc | null | undefined) => (a ? [a.line1, a.line2, a.city, a.state, a.postalCode, a.country].filter((x) => x && String(x).trim()).join(', ') || null : null);

/** A field-by-field comparison of one section, old against new. Lists compare as whole entries. */
function compare(section: ProfileSection, before: Doc, after: Doc): Change[] {
  const out: Change[] = [];
  const push = (field: string, label: string, o: unknown, n: unknown, masked = MASKED.has(field)) => {
    const os = show(o);
    const ns = show(n);
    if (os === ns) return;
    out.push({ field, label, old: masked ? mask(os) : os, new: masked ? mask(ns) : ns });
  };
  if (section === 'address') {
    push('current', 'Current address', addressLine(before.current), addressLine(after.current));
    const perm = (d: Doc) => (d.permanentSameAsCurrent ? 'Same as current address' : addressLine(d.permanent));
    push('permanent', 'Permanent address', before.current || before.permanent ? perm(before) : null, perm(after));
    return out;
  }
  if (section === 'emergency') {
    const line = (c: Doc) => `${c.name} (${c.relationship}), ${c.phone}${c.email ? `, ${c.email}` : ''}`;
    const n = Math.max(before.contacts?.length ?? 0, after.contacts?.length ?? 0);
    for (let i = 0; i < n; i++) push(`contacts.${i}`, `Emergency contact ${i + 1}`, before.contacts?.[i] ? line(before.contacts[i]) : null, after.contacts?.[i] ? line(after.contacts[i]) : null);
    return out;
  }
  if (section === 'education' || section === 'employment') {
    if (section === 'education') push('highestQualification', LABELS.highestQualification!, before.highestQualification, after.highestQualification);
    else push('totalExperienceMonths', LABELS.totalExperienceMonths!, before.totalExperienceMonths, after.totalExperienceMonths);
    const line = (r: Doc) => section === 'education'
      ? [EDUCATION_LEVEL_LABELS[r.level as keyof typeof EDUCATION_LEVEL_LABELS] ?? r.level, r.degree, r.institution, r.yearCompleted, r.percentage !== null && r.percentage !== undefined ? `${r.percentage}%` : null, r.documentId ? 'certificate attached' : null].filter(Boolean).join(' · ')
      : [r.company, r.designation, `${r.from} to ${r.to ?? 'present'}`, r.lastSalary ? `last salary ${r.lastSalary}` : null, r.documentId ? 'document attached' : null].filter(Boolean).join(' · ');
    const n = Math.max(before.records?.length ?? 0, after.records?.length ?? 0);
    for (let i = 0; i < n; i++) push(`records.${i}`, `${section === 'education' ? 'Education' : 'Employment'} ${i + 1}`, before.records?.[i] ? line(before.records[i]) : null, after.records?.[i] ? line(after.records[i]) : null);
    return out;
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) push(k, LABELS[k] ?? k, before[k], after[k]);
  return out;
}

/**
 * The complete employee profile and profile updates. Employees submit changes to their own profile as a profile
 * update (approval type profile_update) that HR approves before anything reaches the official record; HR with
 * employees:update changes other people's profiles directly. Bank and identity numbers are encrypted at rest, masked
 * in every profile view, and in a pending update they are kept encrypted until approval applies them.
 */
@Injectable()
export class ProfileService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationService,
    private readonly approvals: ApprovalsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    this.approvals.register('profile_update', {
      permission: 'profiles:review',
      configurePermission: 'profiles:review',
      defaultSteps: [{ type: 'role', role: 'hr_workspace' }],
      fallbackRole: 'hr_workspace',
      label: 'Profile update',
      link: (id) => `/profile/updates/${id}`,
      attributes: async (tx, id) => {
        const r = await tx.collection('profile_change_requests').findOne({ id });
        const e = r && (await tx.collection('employees').findOne({ id: r.employee_id }));
        if (!e) throw Errors.notFound('Profile update');
        return attrsOf(e);
      },
      details: async (tx, id) => {
        const r = await tx.collection('profile_change_requests').findOne({ id });
        return r ? { section: PROFILE_SECTION_LABELS[r.section as ProfileSection], changes: r.changes, note: r.note ?? null } : null;
      },
      // Proofs the employee attached (identity, address, education records), openable from Approvals. Only ids
      // leave the update; each download is checked and audited by the documents module.
      documents: async (tx, id) => {
        const r = await tx.collection('profile_change_requests').findOne({ id });
        if (!r) return [];
        const data = r.new_data ?? (r.new_enc ? JSON.parse(this.dec(r.new_enc)!) : null) ?? {};
        const docIds = [data.identityDocumentId, data.addressProofDocumentId, ...((data.records ?? []) as Doc[]).map((x) => x.documentId)].filter(Boolean);
        const docs = docIds.length ? await tx.collection('employee_documents').find({ id: { $in: docIds }, archived_at: null }) : [];
        return docs.map((d) => ({ name: `${d.title as string}${d.file_name ? ` (${d.file_name as string})` : ''}`, href: `/files/${d.id as string}` }));
      },
      onApproved: (tx, req) => this.decided(tx, req.resource_id, req.id, 'approved'),
      onRejected: (tx, req) => this.decided(tx, req.resource_id, req.id, 'rejected'),
    });
  }

  private enc(v: string | null | undefined) {
    return v ? encryptField(v, this.config.fieldKeys) : null;
  }
  private dec(v: string | null | undefined) {
    return v ? decryptField(v, this.config.fieldKeys) : null;
  }

  private async employee(tx: TenantTx, id: string) {
    const e = await tx.collection('employees').findOne({ id, erased_at: null });
    if (!e) throw Errors.notFound('Employee');
    return e;
  }

  /** The caller's own employee id, for /profile/me. */
  async myEmployeeId() {
    const s = await this.db.tenant((tx) => this.authz.subject(tx));
    if (!s.employeeId) throw Errors.notFound('Employee record');
    return s.employeeId;
  }

  /** The current values of a section, unmasked (only used inside the service). */
  private async current(tx: TenantTx, e: Doc, section: ProfileSection): Promise<Doc> {
    const p = (await tx.collection('employee_profiles').findOne({ employee_id: e.id })) ?? {};
    switch (section) {
      case 'personal':
        return {
          firstName: e.first_name, lastName: e.last_name ?? '', preferredName: e.preferred_name ?? null, dateOfBirth: e.date_of_birth ?? null, gender: e.gender ?? null,
          personalEmail: e.personal_email ?? null, phone: e.phone ?? null, nationality: p.nationality ?? null, maritalStatus: p.marital_status ?? null, bloodGroup: p.blood_group ?? null,
        };
      case 'address': return p.address ?? { current: null, permanentSameAsCurrent: true, permanent: null };
      case 'emergency': return p.emergency ?? { contacts: [] };
      case 'education': return p.education ?? { highestQualification: null, records: [] };
      case 'employment': return p.employment ?? { totalExperienceMonths: null, records: [] };
      case 'skills': return p.skills ?? { skills: [], languages: [], certifications: [] };
      case 'bank': {
        const s = (await tx.collection('employee_sensitive').findOne({ employee_id: e.id })) ?? {};
        return { accountHolderName: s.account_holder_name ?? null, bankName: s.bank_name ?? null, accountNumber: this.dec(s.bank_account_enc), ifsc: this.dec(s.bank_routing_enc), branchName: s.bank_branch ?? null, accountType: s.account_type ?? null };
      }
      case 'identity': {
        const s = (await tx.collection('employee_sensitive').findOne({ employee_id: e.id })) ?? {};
        const d = p.identity_documents ?? {};
        return { aadhaar: this.dec(s.national_id_enc), pan: this.dec(s.tax_id_enc), otherIdType: s.other_id_type ?? null, otherIdNumber: this.dec(s.other_id_enc), identityDocumentId: d.identityDocumentId ?? null, addressProofDocumentId: d.addressProofDocumentId ?? null };
      }
    }
  }

  /** Writes a section to the official record. */
  private async apply(tx: TenantTx, e: Doc, section: ProfileSection, data: Doc) {
    const by = requestContext.tenantActor().membershipId;
    const profile = async (set: Doc) => tx.collection('employee_profiles').upsert({ employee_id: e.id }, { employee_id: e.id, ...set, updated_by_membership_id: by }, { $set: { ...set, updated_by_membership_id: by } });
    const sensitive = async (set: Doc) => tx.collection('employee_sensitive').upsert({ employee_id: e.id }, { employee_id: e.id, ...set, updated_by: requestContext.tenantActor().userId, updated_at: new Date() }, { $set: { ...set, updated_by: requestContext.tenantActor().userId, updated_at: new Date() } });
    switch (section) {
      case 'personal': {
        if (data.dateOfBirth) {
          const bad = dateOfBirthError(data.dateOfBirth, e.date_of_joining);
          if (bad) throw Errors.validation([{ path: 'dateOfBirth', message: bad }]);
        }
        if (data.personalEmail && e.work_email && String(e.work_email).toLowerCase() === String(data.personalEmail).toLowerCase()) {
          throw Errors.validation([{ path: 'personalEmail', message: 'The personal email must differ from the work email' }]);
        }
        await tx.collection('employees').updateOne({ id: e.id }, { $set: { first_name: data.firstName, last_name: data.lastName ?? '', preferred_name: data.preferredName, date_of_birth: data.dateOfBirth, gender: data.gender, personal_email: data.personalEmail, phone: data.phone } });
        await profile({ nationality: data.nationality, marital_status: data.maritalStatus, blood_group: data.bloodGroup });
        await this.outbox.publish(tx, requestContext.tenantActor().tenantId, 'employee.changed', { employeeId: e.id, fields: Object.keys(data) });
        return;
      }
      case 'bank':
        await sensitive({ account_holder_name: data.accountHolderName, bank_name: data.bankName, bank_branch: data.branchName, account_type: data.accountType, bank_account_enc: this.enc(data.accountNumber), bank_routing_enc: this.enc(String(data.ifsc).toUpperCase()) });
        return;
      case 'identity':
        await sensitive({ national_id_enc: this.enc(data.aadhaar), tax_id_enc: this.enc(data.pan), other_id_type: data.otherIdType, other_id_enc: this.enc(data.otherIdNumber) });
        await profile({ identity_documents: { identityDocumentId: data.identityDocumentId, addressProofDocumentId: data.addressProofDocumentId } });
        return;
      default:
        await profile({ [section]: data });
    }
  }

  private parse(section: ProfileSection, data: unknown) {
    const r = PROFILE_SECTION_SCHEMAS[section].safeParse(data);
    if (!r.success) throw Errors.validation(r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    return r.data as Doc;
  }

  /** Document ids a section points at must be this employee's documents. */
  private async checkDocuments(tx: TenantTx, e: Doc, data: Doc) {
    const ids = [data.identityDocumentId, data.addressProofDocumentId, ...((data.records ?? []) as Doc[]).map((r) => r.documentId)].filter(Boolean) as string[];
    if (!ids.length) return;
    const found = await tx.collection('employee_documents').count({ id: { $in: ids }, employee_id: e.id, archived_at: null });
    if (found !== new Set(ids).size) throw Errors.badRequest('unknown_document', 'A linked document is not one of this person\'s documents');
  }

  /** The whole profile, as the caller may see it. */
  async get(employeeId: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const e = await this.employee(tx, employeeId);
      const self = s.employeeId === e.id;
      if (!self) await this.authz.require('employees:read', attrsOf(e), tx);
      const seeSensitive = self || covers(s, 'employees:sensitive:read', e);
      const p = (await tx.collection('employee_profiles').findOne({ employee_id: e.id })) ?? {};
      const sens = (await tx.collection('employee_sensitive').findOne({ employee_id: e.id })) ?? {};

      // Professional details are HR-controlled and read only here.
      const [dept, desig, loc, entity, manager, shift] = await Promise.all([
        fieldById(tx, 'departments', [e.current_department_id]),
        fieldById(tx, 'designations', [e.current_designation_id]),
        e.current_location_id ? tx.collection('locations').findOne({ id: e.current_location_id }) : null,
        e.current_legal_entity_id ? tx.collection('legal_entities').findOne({ id: e.current_legal_entity_id }) : null,
        e.current_manager_employee_id ? tx.collection('employees').findOne({ id: e.current_manager_employee_id }) : null,
        e.default_shift_id ? tx.collection('shift_templates').findOne({ id: e.default_shift_id }) : null,
      ]);
      const [space, levels] = await Promise.all([fieldById(tx, 'hr_workspaces', [e.hr_workspace_id]), accessLevels(tx, [e.membership_id])]);
      const level = e.membership_id ? (levels.get(e.membership_id) ?? 'employee') : null;
      const calendars = await tx.collection('holiday_calendars').find({ $or: [...(e.current_location_id ? [{ location_id: e.current_location_id }] : []), ...(e.current_legal_entity_id ? [{ location_id: null, legal_entity_id: e.current_legal_entity_id }] : []), { is_default: true }] });
      const cal = calendars.find((c) => e.current_location_id && c.location_id === e.current_location_id) ?? calendars.find((c) => !c.location_id && c.legal_entity_id === e.current_legal_entity_id) ?? calendars.find((c) => c.is_default);
      const offs = ((cal?.weekly_offs as number[] | undefined) ?? [0, 6]).map(Number);
      const professional = {
        employeeCode: e.employee_code, designation: desig.get(e.current_designation_id) ?? null, department: dept.get(e.current_department_id) ?? null,
        manager: manager ? displayName(manager as never) : null, employmentType: e.employment_type, status: e.status, dateOfJoining: e.date_of_joining,
        confirmationDate: e.confirmation_date ?? null, probationEndDate: e.probation_end_date ?? null, workEmail: e.work_email ?? null, grade: e.current_grade ?? null,
        location: loc ? { name: loc.name, address: [loc.address_line, loc.city, loc.region, loc.postal_code, loc.country_code].filter(Boolean).join(', ') || null } : null,
        company: entity ? { name: entity.legal_name ?? entity.name, address: entity.address ? (typeof entity.address === 'string' ? entity.address : addressLine(entity.address)) : null } : null,
        shift: shift ? { name: shift.name, start: shift.start_time, end: shift.end_time } : null,
        workingDays: DAYS.filter((_, i) => !offs.includes(i)),
        workspaceAccess: level ? ACCESS_LEVEL_LABEL[`${level}_workspace` as keyof typeof ACCESS_LEVEL_LABEL] : null,
        assignedWorkspace: space.get(e.hr_workspace_id) ?? 'Central group',
      };

      const identityDocs = p.identity_documents ?? {};
      const bank = sens.bank_account_enc || sens.bank_name ? {
        accountHolderName: sens.account_holder_name ?? null, bankName: sens.bank_name ?? null, branchName: sens.bank_branch ?? null, accountType: sens.account_type ?? null,
        accountNumber: seeSensitive ? mask(this.dec(sens.bank_account_enc)) : null, ifsc: seeSensitive ? this.dec(sens.bank_routing_enc) : null,
      } : null;
      const identity = sens.national_id_enc || sens.tax_id_enc || sens.other_id_enc || identityDocs.identityDocumentId ? {
        aadhaar: seeSensitive ? mask(this.dec(sens.national_id_enc)) : null, pan: seeSensitive ? mask(this.dec(sens.tax_id_enc)) : null,
        otherIdType: sens.other_id_type ?? null, otherIdNumber: seeSensitive ? mask(this.dec(sens.other_id_enc)) : null,
        identityDocumentId: identityDocs.identityDocumentId ?? null, addressProofDocumentId: identityDocs.addressProofDocumentId ?? null,
      } : null;
      const sections = {
        personal: await this.current(tx, e, 'personal'),
        address: p.address ?? null, emergency: p.emergency ?? null, education: p.education ?? null, employment: p.employment ?? null, skills: p.skills ?? null,
        bank: seeSensitive ? bank : bank ? { hidden: true } : null,
        identity: seeSensitive ? identity : identity ? { hidden: true } : null,
      };
      const filled = {
        personal: !!(e.date_of_birth && (e.phone || e.personal_email)),
        address: !!p.address?.current?.line1, emergency: !!p.emergency?.contacts?.length, education: !!p.education?.records?.length,
        employment: !!(p.employment?.records?.length || p.employment?.totalExperienceMonths === 0), skills: !!(p.skills?.skills?.length || p.skills?.languages?.length),
        bank: !!sens.bank_account_enc, identity: !!(sens.national_id_enc || sens.tax_id_enc),
      };
      // The latest open or recently decided update for each section, so the employee sees what is waiting.
      const requests = self || covers(s, 'profiles:review', e)
        ? await tx.collection('profile_change_requests').find({ employee_id: e.id, status: { $in: ['pending', 'info_requested', 'rejected', 'approved'] } }, { sort: { created_at: -1 }, limit: 60 })
        : [];
      const updates: Partial<Record<ProfileSection, Doc>> = {};
      for (const r of requests) if (!updates[r.section as ProfileSection]) updates[r.section as ProfileSection] = { id: r.id, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at ?? null, remarks: r.remarks ?? null, changes: r.changes };
      return {
        employee: { id: e.id, name: displayName(e as never), code: e.employee_code, photo: !!e.photo_key, photoUpdatedAt: e.photo_updated_at ?? null },
        self, completeness: profileCompleteness(filled), filled, professional, sections, updates,
        can: {
          submit: self,
          editDirect: !self && covers(s, 'employees:update', e),
          editSensitive: !self && covers(s, 'employees:update', e) && covers(s, 'employees:sensitive:read', e),
          seeSensitive,
          review: !self && covers(s, 'profiles:review', e),
        },
      };
    });
  }

  /** The employee submits new values for a section. Nothing changes on the record until HR approves. */
  async submit(employeeId: string, input: z.infer<typeof profileChangeInput>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const e = await this.employee(tx, employeeId);
      if (s.employeeId !== e.id) throw Errors.forbidden('Only the employee submits a profile update. HR changes the profile directly.');
      const section = input.section;
      const data = this.parse(section, input.data);
      await this.checkDocuments(tx, e, data);
      const changes = compare(section, await this.current(tx, e, section), data);
      if (!changes.length) throw Errors.badRequest('no_changes', 'Nothing has changed in this section');
      // A newer submission replaces an open one for the same section.
      for (const old of await tx.collection('profile_change_requests').find({ employee_id: e.id, section, status: { $in: OPEN } })) {
        if (old.approval_request_id) await this.approvals.cancel(tx, old.approval_request_id);
        await tx.collection('profile_change_requests').updateOne({ id: old.id }, { $set: { status: 'superseded' }, $push: { history: { at: new Date(), by: actor.membershipId, action: 'superseded', remarks: null } } });
      }
      const sensitive = SENSITIVE_SECTIONS.includes(section);
      const row = await tx.collection('profile_change_requests').insert({
        employee_id: e.id, section, changes, status: 'pending', requested_by_membership_id: actor.membershipId, note: input.note?.trim() || null,
        new_data: sensitive ? null : data, new_enc: sensitive ? this.enc(JSON.stringify(data)) : null,
        history: [{ at: new Date(), by: actor.membershipId, action: 'submitted', remarks: input.note?.trim() || null }],
      });
      const dept = (await fieldById(tx, 'departments', [e.current_department_id])).get(e.current_department_id);
      const summary = `${displayName(e as never)} (${e.employee_code}${dept ? `, ${dept}` : ''}): ${PROFILE_SECTION_LABELS[section]}, ${changes.length} ${changes.length === 1 ? 'change' : 'changes'}, submitted ${istToday()}`;
      const requestId = await this.approvals.start(tx, { resourceType: 'profile_update', resourceId: row.id, subjectEmployeeId: e.id, summary });
      await tx.collection('profile_change_requests').updateOne({ id: row.id }, { $set: { approval_request_id: requestId } });
      await this.audit.record(tx, { action: 'profile_update.submitted', resourceType: 'employee', resourceId: e.id, metadata: { requestId: row.id, section, fields: changes.map((c) => c.field) } });
      return this.view(tx, (await tx.collection('profile_change_requests').findOne({ id: row.id }))!, s);
    });
  }

  /**
   * A data import writes profile sections inside the transaction that creates or updates the employee: each part is
   * merged with what the record already holds, checked by the section's own rules and written like an HR edit. Bank
   * and identity details are never imported. Returns the sections that changed.
   */
  async importSections(tx: TenantTx, employeeId: string, parts: Partial<Record<'personal' | 'address' | 'emergency' | 'education' | 'skills', Doc>>) {
    const written: string[] = [];
    for (const [section, patch] of Object.entries(parts) as [ProfileSection, Doc][]) {
      if (!patch) continue;
      const e = await this.employee(tx, employeeId);
      await this.authz.require('employees:update', attrsOf(e), tx);
      const before = await this.current(tx, e, section);
      const merged = section === 'address'
        ? { ...before, current: { ...(before.current ?? {}), ...(patch.current ?? {}) } }
        : section === 'emergency'
          ? { contacts: [...(patch.contacts ?? []), ...((before.contacts ?? []) as Doc[]).filter((c) => !(patch.contacts ?? []).some((p: Doc) => String(p.phone) === String(c.phone)))].slice(0, 3) }
          : section === 'skills'
            ? { ...before, skills: [...new Set([...((before.skills ?? []) as string[]), ...((patch.skills ?? []) as string[])])].slice(0, 40) }
            : { ...before, ...patch };
      const r = PROFILE_SECTION_SCHEMAS[section].safeParse(merged);
      if (!r.success) throw Errors.validation(r.error.issues.map((i) => ({ path: [section, ...i.path].join('.'), message: i.message })));
      const data = r.data as Doc;
      if (!compare(section, before, data).length) continue;
      await this.apply(tx, e, section, data);
      written.push(section);
    }
    if (written.length) await this.audit.record(tx, { action: 'profile.updated', resourceType: 'employee', resourceId: employeeId, metadata: { sections: written, via: 'import' } });
    return written;
  }

  /** HR changes a section of someone else's profile directly (audited, and the employee is told). */
  async edit(employeeId: string, section: ProfileSection, raw: unknown) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const e = await this.employee(tx, employeeId);
      if (s.employeeId === e.id) throw Errors.forbidden('Submit a profile update for your own profile; HR approves it.');
      await this.authz.require('employees:update', attrsOf(e), tx);
      if (SENSITIVE_SECTIONS.includes(section)) await this.authz.require('employees:sensitive:read', attrsOf(e), tx);
      const data = this.parse(section, raw);
      await this.checkDocuments(tx, e, data);
      const changes = compare(section, await this.current(tx, e, section), data);
      if (!changes.length) return { updated: [] };
      await this.apply(tx, e, section, data);
      await this.audit.record(tx, { action: 'profile.updated', resourceType: 'employee', resourceId: e.id, metadata: { section, fields: changes.map((c) => c.field) } });
      if (e.membership_id && e.membership_id !== actor.membershipId) {
        await this.notifications.notify(tx, { membershipIds: [e.membership_id], kind: 'profile_update.changed_by_hr', title: `HR updated your ${PROFILE_SECTION_LABELS[section].toLowerCase()}`, body: changes.map((c) => c.label).join(', '), link: '/profile', email: SENSITIVE_SECTIONS.includes(section) });
      }
      return { updated: changes.map((c) => c.field) };
    });
  }

  private async view(tx: TenantTx, r: Doc, s: Subject) {
    const e = (await tx.collection('employees').findOne({ id: r.employee_id }))!;
    const dept = (await fieldById(tx, 'departments', [e.current_department_id])).get(e.current_department_id) ?? null;
    const names = await membershipUserNames(tx, [...((r.history ?? []) as Doc[]).map((h) => h.by), r.decided_by_membership_id]);
    return {
      id: r.id as string, section: r.section as ProfileSection, sectionLabel: PROFILE_SECTION_LABELS[r.section as ProfileSection], status: r.status as string,
      employee: { id: e.id, name: displayName(e as never), code: e.employee_code, department: dept },
      changes: r.changes as Change[], note: r.note ?? null, remarks: r.remarks ?? null, createdAt: r.created_at, decidedAt: r.decided_at ?? null,
      decidedBy: r.decided_by_membership_id ? names.get(r.decided_by_membership_id) ?? null : null,
      history: ((r.history ?? []) as Doc[]).map((h) => ({ at: h.at, by: names.get(h.by) ?? null, action: h.action, remarks: h.remarks ?? null })),
      mine: s.employeeId === r.employee_id,
      canDecide: s.employeeId !== r.employee_id && r.status === 'pending' && covers(s, 'profiles:review', e),
    };
  }

  /** Profile updates HR can review (pending by default). */
  async list(status: 'pending' | 'all') {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      if (!grantsFor(s, 'profiles:review').length) throw Errors.forbidden('You cannot review profile updates');
      const scope = await this.authz.filter('profiles:review', EMPLOYEE_FIELDS, tx);
      const ids = (await tx.collection('employees').find(scope, { projection: { id: 1 } })).map((x) => x.id as string).filter((id) => id !== s.employeeId);
      const rows = await tx.collection('profile_change_requests').find({ employee_id: { $in: ids }, ...(status === 'pending' ? { status: { $in: OPEN } } : { status: { $ne: 'superseded' } }) }, { sort: { created_at: -1 }, limit: 200 });
      return Promise.all(rows.map((r) => this.view(tx, r, s)));
    });
  }

  /** The caller's own profile updates. */
  async mine() {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      if (!s.employeeId) return [];
      const rows = await tx.collection('profile_change_requests').find({ employee_id: s.employeeId, status: { $ne: 'superseded' } }, { sort: { created_at: -1 }, limit: 50 });
      return Promise.all(rows.map((r) => this.view(tx, r, s)));
    });
  }

  private async load(tx: TenantTx, id: string) {
    const s = await this.authz.subject(tx);
    const r = await tx.collection('profile_change_requests').findOne({ id });
    if (!r) throw Errors.notFound('Profile update');
    const e = (await tx.collection('employees').findOne({ id: r.employee_id }))!;
    if (s.employeeId !== r.employee_id && !covers(s, 'profiles:review', e)) throw Errors.notFound('Profile update');
    return { r, s, e };
  }

  async get1(id: string) {
    return this.db.tenant(async (tx) => {
      const { r, s } = await this.load(tx, id);
      const v = await this.view(tx, r, s);
      // Documents the update links, so HR can open them while reviewing.
      const data = r.new_data ?? (r.new_enc && v.canDecide ? JSON.parse(this.dec(r.new_enc)!) : null) ?? {};
      const docIds = [data.identityDocumentId, data.addressProofDocumentId, ...((data.records ?? []) as Doc[]).map((x) => x.documentId)].filter(Boolean);
      const docs = docIds.length ? await tx.collection('employee_documents').find({ id: { $in: docIds }, archived_at: null }) : [];
      const trail = r.approval_request_id ? await this.approvals.trail(tx, r.approval_request_id) : [];
      return { ...v, documents: docs.map((d) => ({ id: d.id, title: d.title, fileName: d.file_name, category: d.category })), approvalTrail: trail };
    });
  }

  /** HR approves, rejects or asks for more information (approve and reject go through the approvals engine). */
  async decide(id: string, input: z.infer<typeof profileDecisionInput>) {
    const actor = requestContext.tenantActor();
    const reqId = await this.db.tenant(async (tx) => {
      const { r, s, e } = await this.load(tx, id);
      if (s.employeeId === r.employee_id || !covers(s, 'profiles:review', e)) throw Errors.forbidden('You cannot decide this profile update');
      if (r.status !== 'pending') throw Errors.conflict('invalid_state', 'This profile update is not waiting for a decision');
      if (input.decision !== 'request_info') return r.approval_request_id as string;
      if (r.approval_request_id) await this.approvals.cancel(tx, r.approval_request_id);
      await tx.collection('profile_change_requests').updateOne({ id }, { $set: { status: 'info_requested', remarks: input.remarks!.trim(), decided_at: new Date(), decided_by_membership_id: actor.membershipId }, $push: { history: { at: new Date(), by: actor.membershipId, action: 'info_requested', remarks: input.remarks!.trim() } } });
      await this.audit.record(tx, { action: 'profile_update.info_requested', resourceType: 'employee', resourceId: r.employee_id, metadata: { requestId: id } });
      if (e.membership_id) await this.notifications.notify(tx, { membershipIds: [e.membership_id], kind: 'profile_update.info_requested', title: `HR needs more information for your ${PROFILE_SECTION_LABELS[r.section as ProfileSection].toLowerCase()} update`, body: input.remarks!.trim(), link: '/profile', email: true });
      return null;
    });
    if (reqId) await this.approvals.decide(reqId, input.decision === 'approve' ? 'approve' : 'reject', input.remarks?.trim() || undefined);
    return this.get1(id);
  }

  /** The employee withdraws an update that is still open. */
  async cancel(id: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const { r, s } = await this.load(tx, id);
      if (s.employeeId !== r.employee_id) throw Errors.forbidden('Only the employee can withdraw their update');
      if (!OPEN.includes(r.status)) throw Errors.conflict('invalid_state', 'This update is already decided');
      if (r.approval_request_id) await this.approvals.cancel(tx, r.approval_request_id);
      await tx.collection('profile_change_requests').updateOne({ id }, { $set: { status: 'cancelled' }, $push: { history: { at: new Date(), by: actor.membershipId, action: 'cancelled', remarks: null } } });
      return this.view(tx, (await tx.collection('profile_change_requests').findOne({ id }))!, s);
    });
  }

  /** Called by the approvals engine: an approved update is written to the official record. */
  private async decided(tx: TenantTx, id: string, approvalId: string, result: 'approved' | 'rejected') {
    const r = await tx.collection('profile_change_requests').findOne({ id });
    if (!r || r.status !== 'pending') return;
    const step = await tx.collection('approval_steps').findOne({ request_id: approvalId, status: result }, { sort: { seq: -1 } });
    const remarks = (step?.comment ?? null) as string | null;
    const by = requestContext.tenantActor().membershipId;
    if (result === 'approved') {
      const e = (await tx.collection('employees').findOne({ id: r.employee_id }))!;
      const data = r.new_data ?? JSON.parse(this.dec(r.new_enc)!);
      await this.apply(tx, e, r.section as ProfileSection, this.parse(r.section as ProfileSection, data));
    }
    // Once applied, the submitted numbers are not kept twice.
    await tx.collection('profile_change_requests').updateOne({ id }, { $set: { status: result, remarks, decided_at: new Date(), decided_by_membership_id: by, ...(result === 'approved' ? { new_enc: null } : {}) }, $push: { history: { at: new Date(), by, action: result, remarks } } });
    await this.audit.record(tx, { action: `profile_update.${result}`, resourceType: 'employee', resourceId: r.employee_id, metadata: { requestId: id, section: r.section, fields: (r.changes as Change[]).map((c) => c.field), remarks } });
  }

  /** Sections in order, for clients. */
  sections() {
    return PROFILE_SECTIONS.map((key) => ({ key, label: PROFILE_SECTION_LABELS[key], sensitive: SENSITIVE_SECTIONS.includes(key) }));
  }
}
