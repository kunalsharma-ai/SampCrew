'use client';
import { ADULT_AGE, addYears, ageOn, DOCUMENT_CATEGORIES, dateOfBirthError, dateOfBirthRange, designationLibrary, earliestJoining, isMinorOn, MIN_WORKING_AGE, phoneError } from '@crew/contracts';
import { Alert, Button, Checkbox, DatePicker, Dialog, Field, Input, Select, cn } from '@crew/ui';
import { AlertTriangle, Camera, Check, FileUp, Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import type { Department, Designation, Employee, LegalEntity, Location, OnboardingTemplate } from '@/lib/types';
import type { SetAccessRequest } from '@crew/contracts';
import { AccessEditor, accessBody, LEVEL_OPTIONS } from '@/components/access-editor';
import type { Structure } from '../payroll/types';
import { type DeviceOption, EnrolmentRows, LoginModeChoice, OwnPassword, type ShiftOption } from './[id]/profile-extras';
import { completeHireAction, createDepartmentAction, createLocationAction, createShiftAction, type DraftData, duplicateCheckAction, saveHireDraftAction } from './actions';
import type { HireDone } from './employees-view';

export interface EmployeeDraft { id: string; step: number; data: DraftData; updatedAt: string }
/** A leave policy that keeps a balance, for an existing employee's opening balances. */
/** An asset that is free to hand over, offered when adding someone who already works here. */
export interface AssetOption { id: string; assetCode: string; name: string; category: string | null }
export interface LeavePolicyOption { leaveTypeId: string; leaveTypeName: string; legalEntityId: string | null; accrualMethod: string; typeArchived: boolean }

export const HIRE_STEPS = ['Personal details', 'Employment', 'Department & reporting', 'Compensation', 'Documents', 'Attendance & access', 'Review'] as const;

/** Which step holds each field, so a server error can take HR straight to it. */
const FIELD_STEP: Record<string, number> = {
  joinedAs: 0, firstName: 0, lastName: 0, preferredName: 0, workEmail: 0, personalEmail: 0, phone: 0, dateOfBirth: 0, gender: 0, minorConfirmed: 0,
  dateOfJoining: 1, legalEntityId: 1, employmentType: 1, designationId: 1, designationName: 1, grade: 1, probationMonths: 1, employeeCode: 1, confirmationDate: 1, openingLeaveBalances: 1,
  departmentId: 2, locationId: 2, managerEmployeeId: 2,
  structureId: 3, annualCtc: 3, salaryFrom: 3,
  inviteToCrew: 5, loginMode: 5, initialPassword: 5, defaultShiftId: 5, attendanceEnrolments: 5, onboardingTemplateId: 5, membershipId: 5,
};
const EMPLOYEE_FIELDS = ['firstName', 'lastName', 'preferredName', 'workEmail', 'personalEmail', 'phone', 'dateOfBirth', 'gender', 'dateOfJoining', 'legalEntityId', 'employmentType', 'designationId', 'grade', 'departmentId', 'locationId', 'managerEmployeeId', 'hrWorkspaceId'];
const CATEGORY_LABEL: Record<string, string> = { id_proof: 'ID proof', address_proof: 'Address proof', contract: 'Contract', offer_letter: 'Offer letter', policy: 'Policy', certificate: 'Certificate', tax: 'Tax', other: 'Other' };
const TYPE_LABEL: Record<string, string> = { full_time: 'Full time', part_time: 'Part time', contract: 'Contract', intern: 'Intern', temporary: 'Temporary' };
const MAX_UPLOAD = 10 * 1024 * 1024;
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,39}$/;
const DAYS = /^-?\d{1,3}(\.\d{1,2})?$/;
/** Mail providers people use privately: never suggested as the company's domain. */
const PUBLIC_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'rediffmail.com', 'zoho.com', 'gmx.com', 'mail.com']);
const LIBRARY = designationLibrary();
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** date + n months, clamped to the end of a shorter month (as the API works out probation). */
function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}
const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_PHOTO = 5 * 1024 * 1024;
const strongEnough = (pw: string) => pw.length >= 12 && [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length >= 3;
type LoginMode = 'none' | 'invite' | 'password';
type Enrolment = { deviceUserId: string; deviceId: string };

type Match = { id: string; displayName: string; employeeCode: string; status: string; departmentName: string | null; reasons: string[] };
type Doc = { file: File; category: string; title: string; hrOnly: boolean };

type Kind = 'department' | 'location' | 'shift';

interface Props {
  open: boolean;
  draft: EmployeeDraft | null;
  onClose: () => void;
  onDone: (r: HireDone) => void;
  entities: LegalEntity[];
  departments: Department[];
  locations: Location[];
  designations: Designation[];
  managers: Employee[];
  templates: OnboardingTemplate[];
  structures: Structure[];
  canPay: boolean;
  canDocs: boolean;
  shifts: ShiftOption[] | null;
  devices: DeviceOption[] | null;
  canManageOrg: boolean;
  canAttendance: boolean;
  canConfigureShifts: boolean;
  /** Leave policies that keep balances, when this person may set balances; null hides opening balances. */
  leavePolicies?: LeavePolicyOption[] | null;
  /** Available assets, when this person may hand them over; null hides the picker. */
  availableAssets?: AssetOption[] | null;
  /**
   * HR Workspaces the new person can be added to. `central` is whether the company's central group is one of the
   * choices (only for company-wide admins); null hides the choice (the company has no HR Workspaces).
   */
  hrWorkspaces?: { options: { id: string; name: string }[]; central: boolean } | null;
  /** Giving workspace access with the login; null: the login gets Employee Workspace access. */
  accessChoice?: { canGiveSuper: boolean; hrWorkspaces: { id: string; name: string }[] } | null;
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/**
 * The guided hire: seven steps, saved on the server as a draft each time HR moves on (so a hire can be finished
 * later, on another device), with a duplicate check before anything is created. Completing it creates the
 * employee, job record and onboarding checklist, then assigns the salary and uploads the documents.
 */
export function HireWizard(p: Props) {
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const blank = (): DraftData => ({
    dateOfJoining: today, legalEntityId: p.entities[0]?.id ?? '', hrWorkspaceId: p.hrWorkspaces && !p.hrWorkspaces.central ? (p.hrWorkspaces.options[0]?.id ?? '') : '', employmentType: 'full_time', probationMonths: 6,
    onboardingTemplateId: p.templates.find((t) => t.isDefault)?.id ?? '', loginMode: 'none', joinedAs: 'new_joiner',
  });
  const [v, setV] = useState<DraftData>(blank);
  const [access, setAccess] = useState<SetAccessRequest>({ level: 'employee' });
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  // The temporary password is never saved in a draft.
  const [ownPassword, setOwnPassword] = useState(false);
  const [password, setPassword] = useState('');
  // Designations and departments added from inside the wizard join the lists straight away.
  const [designations, setDesignations] = useState(p.designations);
  const [departments, setDepartments] = useState(p.departments);
  const [locations, setLocations] = useState(p.locations);
  const [shifts, setShifts] = useState(p.shifts);
  const [adding, setAdding] = useState<null | Kind>(null);
  const [newName, setNewName] = useState('');
  const [shiftTimes, setShiftTimes] = useState({ start: '09:00', end: '18:00' });
  const [handOver, setHandOver] = useState<string[]>([]);
  const [assetQuery, setAssetQuery] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [checkedKey, setCheckedKey] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const idem = useRef(crypto.randomUUID());

  // Each time the wizard opens: a fresh hire, or the chosen draft.
  useEffect(() => {
    if (!p.open) return;
    const d = p.draft;
    // Drafts saved before login choices existed carry inviteToCrew instead of loginMode.
    const restored = d ? { ...blank(), ...d.data } : blank();
    if (d && d.data.loginMode === undefined) restored.loginMode = d.data.inviteToCrew ? 'invite' : 'none';
    // Drafts saved before the designation could be typed carry only the chosen id.
    if (d && d.data.designation === undefined && d.data.designationId) restored.designation = p.designations.find((x) => x.id === d.data.designationId)?.name ?? '';
    setV(restored);
    setStep(d ? Math.min(d.step, HIRE_STEPS.length - 1) : 0);
    setReached(d ? Math.min(d.step, HIRE_STEPS.length - 1) : 0);
    setDraftId(d?.id ?? null);
    setSavedAt(d ? d.updatedAt : null);
    setDocs([]);
    setPhoto(null);
    setPhotoPreview(null);
    setOwnPassword(false);
    setPassword('');
    setHandOver([]);
    setAssetQuery('');
    setDesignations(p.designations);
    setDepartments(p.departments);
    setAdding(null);
    setErrors({});
    setError(null);
    setMatches(null);
    setCheckedKey(null);
    idem.current = crypto.randomUUID();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.open, p.draft]);

  const set = (k: string, val: string | number | boolean | null) => {
    setV((cur) => {
      const next = { ...cur, [k]: val };
      // Someone already working here usually needs no joining checklist; a new joiner gets the default again.
      if (k === 'joinedAs' && val !== cur.joinedAs) {
        const def = p.templates.find((t) => t.isDefault)?.id ?? '';
        if (val === 'existing' && str(cur.onboardingTemplateId) === def) next.onboardingTemplateId = 'none';
        if (val !== 'existing' && str(cur.onboardingTemplateId) === 'none') next.onboardingTemplateId = def;
      }
      // Department and location belong to a legal entity; clear them when the entity changes.
      if (k === 'legalEntityId') {
        if (next.departmentId && !departments.some((d) => d.id === next.departmentId && (!d.legalEntityId || d.legalEntityId === val))) next.departmentId = '';
        if (next.locationId && !locations.some((l) => l.id === next.locationId && l.legalEntityId === val)) next.locationId = '';
      }
      return next;
    });
    setErrors((e) => (e[k] ? { ...e, [k]: '' } : e));
  };
  const entity = str(v.legalEntityId);
  const country = p.entities.find((x) => x.id === entity)?.countryCode ?? null;
  const existing = v.joinedAs === 'existing';
  const joining = str(v.dateOfJoining);
  const dob = str(v.dateOfBirth);
  const minor = isMinorOn(dob, joining) && !dateOfBirthError(dob, joining);
  const dobRange = joining ? dateOfBirthRange(joining) : null;
  // The designation is typed or picked from the suggestions: one already in the workspace is used, any other is added.
  const designationText = str(v.designation).trim().replace(/\s+/g, ' ');
  const designationMatch = designations.find((d) => d.name.toLowerCase() === designationText.toLowerCase());
  const designationIsNew = !!designationText && !designationMatch;
  const designationSuggestions = useMemo(() => {
    const have = new Set(designations.map((d) => d.name.toLowerCase()));
    return [...designations.map((d) => ({ name: d.name, note: 'In use' })), ...LIBRARY.filter((x) => !have.has(x.name.toLowerCase())).map((x) => ({ name: x.name, note: 'Suggested' }))];
  }, [designations]);
  // The company's email domain, from the work emails already in SampCrew, to suggest one for this person.
  const companyDomain = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of p.managers) {
      const dom = m.workEmail?.split('@')[1]?.toLowerCase();
      if (dom && !PUBLIC_MAIL.has(dom)) counts.set(dom, (counts.get(dom) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }, [p.managers]);
  const slugName = (x: unknown) => str(x).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const suggestedWorkEmail = companyDomain && slugName(v.firstName) ? `${[slugName(v.firstName), slugName(v.lastName)].filter(Boolean).join('.')}@${companyDomain}` : null;
  // Leave types with a balance in this person's legal entity: an entity's own policy wins over the workspace-wide one.
  const balanceTypes = useMemo(() => {
    const byType = new Map<string, LeavePolicyOption>();
    for (const x of p.leavePolicies ?? []) {
      if (x.legalEntityId && x.legalEntityId !== entity) continue;
      if (!byType.has(x.leaveTypeId) || x.legalEntityId) byType.set(x.leaveTypeId, x);
    }
    return [...byType.values()].sort((a, b) => a.leaveTypeName.localeCompare(b.leaveTypeName));
  }, [p.leavePolicies, entity]);
  const opening: Record<string, string> = (() => { try { return JSON.parse(str(v.openingBalances) || '{}') as Record<string, string>; } catch { return {}; } })();
  const setOpening = (typeId: string, days: string) => set('openingBalances', JSON.stringify({ ...opening, [typeId]: days }));
  const openingRows = balanceTypes.filter((t) => str(opening[t.leaveTypeId]).trim() !== '');
  // What an existing employee's status will be: confirmed on the date given, or when their probation ended.
  const probationEnd = joining && Number(v.probationMonths) > 0 ? addDays(addMonths(joining, Number(v.probationMonths)), -1) : null;
  const confirmedOn = existing ? (str(v.confirmationDate) || (probationEnd === null ? joining : probationEnd < today ? addDays(probationEnd, 1) : '')) : '';
  const loginMode = (str(v.loginMode) || 'none') as LoginMode;
  const enrolments: Enrolment[] = (() => { try { return JSON.parse(str(v.enrolments) || '[]') as Enrolment[]; } catch { return []; } })();
  const setEnrolments = (rows: Enrolment[]) => set('enrolments', JSON.stringify(rows));
  const name = [str(v.firstName), str(v.lastName)].filter(Boolean).join(' ');
  const dupKey = JSON.stringify([v.firstName, v.lastName, v.workEmail, v.personalEmail, v.phone, v.dateOfBirth].map((x) => str(x).trim().toLowerCase()));
  const docBytes = docs.reduce((n, d) => n + d.file.size, 0);

  // A resumed draft (or details edited since) is checked again for duplicates on the review step.
  useEffect(() => {
    if (!p.open || step !== HIRE_STEPS.length - 1 || checkedKey === dupKey) return;
    let live = true;
    const body: Record<string, string> = {};
    for (const k of ['firstName', 'lastName', 'workEmail', 'personalEmail', 'phone', 'dateOfBirth']) if (str(v[k]).trim()) body[k] = str(v[k]).trim();
    void duplicateCheckAction(body).then((r) => {
      if (!live) return;
      setCheckedKey(dupKey);
      setMatches(r.ok && r.data && r.data.matches.length ? r.data.matches : null);
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.open, step, dupKey, checkedKey]);


  function validate(s: number): Record<string, string> {
    const e: Record<string, string> = {};
    if (s === 0) {
      if (!str(v.firstName).trim()) e.firstName = 'Enter a first name';
      for (const k of ['workEmail', 'personalEmail']) if (str(v[k]) && !EMAIL.test(str(v[k]))) e[k] = 'Enter a valid email address';
      if (!e.workEmail && str(v.workEmail) && str(v.workEmail).trim().toLowerCase() === str(v.personalEmail).trim().toLowerCase()) e.workEmail = 'Use their work email here, not their personal email';
      const ph = phoneError(str(v.phone), country);
      if (ph) e.phone = ph;
      const born = dateOfBirthError(dob, joining);
      if (born) e.dateOfBirth = born;
      else if (minor && v.minorConfirmed !== true) e.minorConfirmed = `They are ${ageOn(dob, joining)} on the joining date: confirm they may be employed`;
    }
    if (s === 1) {
      if (!joining) e.dateOfJoining = 'Choose the joining date';
      else if (existing && joining > today) e.dateOfJoining = 'Someone already working here joined on or before today';
      else if (dob && joining < earliestJoining(dob)) e.dateOfJoining = `They turn ${MIN_WORKING_AGE} on ${earliestJoining(dob)}; the joining date cannot be earlier`;
      if (!entity) e.legalEntityId = 'Choose the legal entity';
      const pm = Number(v.probationMonths);
      if (!Number.isInteger(pm) || pm < 0 || pm > 24) e.probationMonths = 'Use 0 to 24 months';
      if (designationText.length > 120) e.designationName = 'Use up to 120 characters';
      if (existing && str(v.employeeCode).trim() && !CODE.test(str(v.employeeCode).trim())) e.employeeCode = 'Use up to 40 letters, digits, -, _, / or .';
      if (existing && str(v.confirmationDate)) {
        if (str(v.confirmationDate) < joining) e.confirmationDate = 'The confirmation date cannot be before the joining date';
        else if (str(v.confirmationDate) > today) e.confirmationDate = 'Use a date up to today. A future confirmation is done from the profile on that day';
      }
      if (existing && openingRows.some((t) => !DAYS.test(str(opening[t.leaveTypeId]).trim()))) e.openingLeaveBalances = 'Enter days as a number, such as 12 or 7.5';
    }
    if (s === 3 && str(v.structureId)) {
      if (!MONEY.test(str(v.annualCtc).replace(/,/g, ''))) e.annualCtc = 'Enter the annual CTC, such as 600000';
    }
    if (s === 4 && docBytes > MAX_UPLOAD) e.documents = 'Attach up to 10 MB here; add larger files from the profile after the hire';
    if (s === 5 && loginMode !== 'none' && !str(v.workEmail)) e.workEmail = 'A work email is needed for a SampCrew login: it is their sign-in name';
    if (s === 5 && loginMode === 'password' && ownPassword && !strongEnough(password)) e.initialPassword = 'Use 12+ characters with three of: lowercase, uppercase, numbers, symbols';
    if (s === 5 && enrolments.some((x) => x.deviceUserId.trim() && !/^[A-Za-z0-9_-]{1,32}$/.test(x.deviceUserId.trim()))) e.attendanceEnrolments = 'Enrolment numbers use up to 32 letters, digits, - or _';
    return e;
  }

  const saveDraft = (nextStep: number) => {
    if (!str(v.firstName).trim()) return Promise.resolve();
    return saveHireDraftAction(draftId, nextStep, v).then((r) => {
      if (r.ok && r.data) { setDraftId(r.data.id); setSavedAt(r.data.updatedAt); }
    });
  };

  const go = (to: number) => {
    setError(null);
    if (to <= step) { setStep(to); return; }
    for (let s = step; s < to; s++) {
      const e = validate(s);
      if (Object.keys(e).length) {
        setErrors(e);
        setStep(Object.keys(e).map((k) => FIELD_STEP[k] ?? s).reduce((a, b) => Math.min(a, b), s));
        return;
      }
    }
    start(async () => {
      // Before leaving the personal details, look for an existing record of the same person.
      if (step === 0 && checkedKey !== dupKey) {
        const body: Record<string, string> = {};
        for (const k of ['firstName', 'lastName', 'workEmail', 'personalEmail', 'phone', 'dateOfBirth']) if (str(v[k]).trim()) body[k] = str(v[k]).trim();
        const r = await duplicateCheckAction(body);
        setCheckedKey(dupKey);
        if (r.ok && r.data && r.data.matches.length) { setMatches(r.data.matches); return; }
        setMatches(null);
      }
      setStep(to);
      setReached((x) => Math.max(x, to));
      await saveDraft(to);
    });
  };

  const close = (save: boolean) => {
    if (save) start(async () => { await saveDraft(step); router.refresh(); p.onClose(); });
    else { p.onClose(); if (draftId) router.refresh(); }
  };

  const submit = () => {
    for (let s = 0; s < HIRE_STEPS.length - 1; s++) {
      const e = validate(s);
      if (Object.keys(e).length) { setErrors(e); setStep(Math.min(...Object.keys(e).map((k) => FIELD_STEP[k] ?? s))); return; }
    }
    const employee: Record<string, unknown> = { loginMode, probationMonths: Number(v.probationMonths ?? 6) };
    if (loginMode !== 'none' && access.level !== 'employee') employee.access = accessBody(access);
    if (loginMode === 'password' && ownPassword) employee.initialPassword = password;
    if (str(v.defaultShiftId)) employee.defaultShiftId = str(v.defaultShiftId);
    const enrol = enrolments.filter((x) => x.deviceUserId.trim()).map((x) => ({ deviceUserId: x.deviceUserId.trim(), deviceId: x.deviceId || null }));
    if (enrol.length) employee.attendanceEnrolments = enrol;
    for (const k of EMPLOYEE_FIELDS) { const x = str(v[k]).trim(); if (x) employee[k] = x; }
    delete employee.designationId;
    if (designationMatch) employee.designationId = designationMatch.id;
    else if (designationText) employee.designationName = designationText;
    if (minor) employee.minorConfirmed = true;
    employee.joinedAs = existing ? 'existing' : 'new_joiner';
    if (existing) {
      if (str(v.employeeCode).trim()) employee.employeeCode = str(v.employeeCode).trim();
      if (str(v.confirmationDate)) employee.confirmationDate = str(v.confirmationDate);
      if (openingRows.length) employee.openingLeaveBalances = openingRows.map((t) => ({ leaveTypeId: t.leaveTypeId, days: str(opening[t.leaveTypeId]).trim() }));
      if (p.availableAssets && handOver.length) employee.assetIds = handOver;
    }
    const tpl = str(v.onboardingTemplateId);
    employee.onboardingTemplateId = tpl === 'none' ? null : tpl || undefined;
    const salary = p.canPay && str(v.structureId)
      ? { structureId: str(v.structureId), annualCtc: str(v.annualCtc).replace(/,/g, ''), effectiveFrom: str(v.salaryFrom) || str(v.dateOfJoining) }
      : null;
    const fd = new FormData();
    fd.set('payload', JSON.stringify({ employee, salary, draftId, documents: docs.map((d) => ({ category: d.category, title: d.title.trim() || d.file.name, visibility: d.hrOnly ? 'hr_only' : 'employee' })) }));
    fd.set('idempotencyKey', idem.current);
    for (const d of docs) fd.append('documents', d.file, d.file.name);
    if (photo) fd.set('photo', photo, photo.name);
    setError(null);
    start(async () => {
      const r = await completeHireAction(fd);
      if (!r.ok) {
        setError(r.message);
        const fe = ('fieldErrors' in r && r.fieldErrors) || {};
        setErrors(fe);
        const steps = Object.keys(fe).map((k) => FIELD_STEP[k]).filter((s): s is number => s !== undefined);
        if (steps.length) setStep(Math.min(...steps));
        return;
      }
      const { employeeId, inviteUrl, warnings, login } = r.data;
      p.onClose();
      // With an invitation link or a temporary password to hand over, or something left to finish, stay here; otherwise open the new profile.
      if (inviteUrl || login || warnings.length) { p.onDone({ inviteUrl, warnings, name, login }); router.refresh(); }
      else router.push(`/employees/${employeeId}`);
    });
  };

  const last = step === HIRE_STEPS.length - 1;
  const deptOptions = departments.filter((d) => !d.legalEntityId || d.legalEntityId === entity);
  const locOptions = locations.filter((l) => l.legalEntityId === entity);
  const lookup = <T extends { id: string; name: string }>(list: T[], id: unknown) => list.find((x) => x.id === id)?.name ?? '—';
  const manager = p.managers.find((m) => m.id === v.managerEmployeeId);
  const structure = p.structures.find((s) => s.id === v.structureId);
  const shift = shifts?.find((x) => x.id === v.defaultShiftId);
  const FIELD_OF: Record<Kind, string> = { department: 'departmentId', location: 'locationId', shift: 'defaultShiftId' };
  const addOption = (kind: Kind) => {
    const n = newName.trim();
    if (!n) return;
    // A name already on the list is simply chosen, not added twice.
    const list: { id: string; name: string }[] = kind === 'department' ? deptOptions : kind === 'location' ? locOptions : (shifts ?? []);
    const same = list.find((x) => x.name.trim().toLowerCase() === n.toLowerCase());
    if (same) { set(FIELD_OF[kind], same.id); setErrors((e) => ({ ...e, [FIELD_OF[kind]]: '' })); setAdding(null); setNewName(''); return; }
    start(async () => {
      const ent = p.entities.find((x) => x.id === entity);
      const r = kind === 'department' ? await createDepartmentAction(n, null)
          : kind === 'location' ? await createLocationAction(n, entity, ent?.countryCode ?? 'IN', ent?.timezone ?? 'Asia/Kolkata')
            : await createShiftAction(n, shiftTimes.start, shiftTimes.end);
      if (!r.ok || !r.data) { setErrors((e) => ({ ...e, [FIELD_OF[kind]]: r.ok ? 'Could not add it' : (Object.values(r.fieldErrors ?? {})[0] ?? r.message) })); return; }
      const row = r.data as { id: string; name: string; code?: string; startTime?: string; endTime?: string };
      if (kind === 'department') setDepartments((d) => [...d, { id: row.id, name: row.name, code: null, parentId: null, legalEntityId: null, businessUnitId: null, headMembershipId: null, memberCount: 0 }]);
      else if (kind === 'location') setLocations((l) => [...l, { id: row.id, name: row.name, code: null, kind: 'office', legalEntityId: entity, timezone: ent?.timezone ?? '', city: null, region: null, countryCode: ent?.countryCode ?? '', latitude: null, longitude: null, geofenceRadiusM: null, addressLine: null, postalCode: null }]);
      else setShifts((x) => [...(x ?? []), { id: row.id, name: row.name, code: row.code ?? '', startTime: row.startTime ?? shiftTimes.start, endTime: row.endTime ?? shiftTimes.end }]);
      set(FIELD_OF[kind], row.id);
      setErrors((e) => ({ ...e, [FIELD_OF[kind]]: '' }));
      setAdding(null);
      setNewName('');
    });
  };
  const PLACEHOLDER: Record<Kind, string> = { department: 'Customer Success', location: 'Pune plant', shift: 'Morning shift' };
  const mayAdd = (kind: Kind) => (kind === 'shift' ? p.canConfigureShifts : p.canManageOrg);
  const addInline = (kind: Kind) => mayAdd(kind) && (adding === kind ? (
    <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
      <Input aria-label={`New ${kind} name`} value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={kind === 'shift' ? 80 : 120} placeholder={PLACEHOLDER[kind]} autoFocus className="min-w-40 flex-1"
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addOption(kind); } }} />
      {kind === 'shift' && (
        <>
          <Input aria-label="Shift starts" type="time" value={shiftTimes.start} onChange={(e) => setShiftTimes((t) => ({ ...t, start: e.target.value }))} className="w-28" />
          <span className="text-xs text-fg-subtle">to</span>
          <Input aria-label="Shift ends" type="time" value={shiftTimes.end} onChange={(e) => setShiftTimes((t) => ({ ...t, end: e.target.value }))} className="w-28" />
        </>
      )}
      <Button size="sm" onClick={() => addOption(kind)} loading={pending}>Add</Button>
      <Button size="sm" variant="ghost" onClick={() => { setAdding(null); setNewName(''); }}>Cancel</Button>
    </div>
  ) : (
    <button type="button" className="inline-flex items-center gap-1 justify-self-start text-xs font-medium text-accent hover:underline sm:col-span-2" onClick={() => { setAdding(kind); setNewName(''); }}>
      <Plus className="size-3.5" /> New {kind}
    </button>
  ));
  const template = str(v.onboardingTemplateId) === 'none' ? 'No checklist' : lookup(p.templates, v.onboardingTemplateId || p.templates.find((t) => t.isDefault)?.id);

  return (
    <Dialog
      open={p.open}
      onClose={() => close(false)}
      size="lg"
      title={name ? `Add employee: ${name}` : 'Add employee'}
      description={savedAt ? `Draft saved ${new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. You can close this and finish later.` : 'Creates the employee record, their first job record and onboarding checklist. A SampCrew login is optional.'}
      footer={
        <div className="flex w-full items-center gap-2">
          {str(v.firstName).trim() && <Button variant="ghost" onClick={() => close(true)} disabled={pending}>Save and finish later</Button>}
          <span className="flex-1" />
          {step > 0 && <Button variant="secondary" onClick={() => go(step - 1)} disabled={pending}>Back</Button>}
          {last ? (
            <Button type="submit" form="hire-form" loading={pending}>Add employee</Button>
          ) : (
            <Button onClick={() => go(step + 1)} loading={pending}>{step === 0 && matches && checkedKey === dupKey ? 'This is a different person' : `Next: ${HIRE_STEPS[step + 1]}`}</Button>
          )}
        </div>
      }
    >
      <ol className="mb-5 flex flex-wrap gap-1.5" aria-label="Steps">
        {HIRE_STEPS.map((label, i) => (
          <li key={label}>
            <button
              type="button"
              onClick={() => go(i)}
              disabled={i > reached || pending}
              aria-current={i === step ? 'step' : undefined}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
                i === step ? 'border-accent bg-accent text-accent-fg' : i < step || i <= reached ? 'border-border bg-surface text-fg hover:bg-bg-subtle' : 'border-border text-fg-subtle',
              )}
            >
              <span className="font-mono">{i < step ? <Check className="size-3" /> : i + 1}</span> {label}
            </button>
          </li>
        ))}
      </ol>
      <form
        id="hire-form"
        noValidate
        onSubmit={(e) => { e.preventDefault(); if (last) submit(); else go(step + 1); }}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2"
      >
        <h3 className="text-sm font-semibold sm:col-span-2">{HIRE_STEPS[step]}</h3>
        {error && <Alert tone="danger" className="sm:col-span-2">{error}</Alert>}

        {step === 0 && (
          <>
            {matches && (
              <Alert tone="warning" title="This person may already have a record" className="sm:col-span-2">
                <ul className="mt-1 space-y-1">
                  {matches.map((m) => (
                    <li key={m.id}>
                      <Link href={`/employees/${m.id}`} target="_blank" className="font-medium text-accent hover:underline">{m.displayName}</Link>{' '}
                      <span className="font-mono text-xs">{m.employeeCode}</span> · {m.departmentName ?? 'No department'} · {m.status.replace('_', ' ')} · {m.reasons.join(', ')}
                    </li>
                  ))}
                </ul>
                <p className="mt-2">Check before going on. If this is someone new, continue.</p>
              </Alert>
            )}
            <fieldset className="sm:col-span-2">
              <legend className="mb-1.5 text-[0.8125rem] font-medium">Who are you adding?</legend>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {([['new_joiner', 'A new joiner', 'Joining now or on a date ahead. Gets the joining checklist.'], ['existing', 'Someone already working here', 'Add their record with their real joining date, employee code and leave balances.']] as const).map(([val, label, help]) => (
                  <label key={val} className={cn('flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-[0.8125rem]', (existing ? 'existing' : 'new_joiner') === val ? 'border-accent bg-accent/5' : 'border-border hover:bg-bg-subtle')}>
                    <input type="radio" name="joinedAs" value={val} checked={(existing ? 'existing' : 'new_joiner') === val} onChange={() => set('joinedAs', val)} className="mt-0.5 accent-[var(--accent)]" />
                    <span><span className="block font-medium text-fg">{label}</span><span className="block text-xs text-fg-subtle">{help}</span></span>
                  </label>
                ))}
              </div>
            </fieldset>
            <Field label="First name" required error={errors.firstName}>{(f) => <Input {...f} name="firstName" value={str(v.firstName)} onChange={(e) => set('firstName', e.target.value)} maxLength={80} autoFocus />}</Field>
            <Field label="Last name" error={errors.lastName}>{(f) => <Input {...f} name="lastName" value={str(v.lastName)} onChange={(e) => set('lastName', e.target.value)} maxLength={80} />}</Field>
            <Field label="Preferred name" hint="Shown across SampCrew instead of the first name">{(f) => <Input {...f} name="preferredName" value={str(v.preferredName)} onChange={(e) => set('preferredName', e.target.value)} maxLength={80} />}</Field>
            <Field
              label="Date of birth"
              error={errors.dateOfBirth}
              hint={dobRange ? `With joining on ${joining}: born ${dobRange.min.slice(0, 4)} to ${dobRange.max} (at least ${MIN_WORKING_AGE} on joining)` : undefined}
            >
              {(f) => (
                <DatePicker
                  {...f}
                  name="dateOfBirth"
                  value={dob}
                  onChange={(x) => { set('dateOfBirth', x); setErrors((er) => ({ ...er, minorConfirmed: '' })); }}
                  min={dobRange?.min}
                  max={dobRange?.max ?? today}
                  openTo={joining ? addYears(joining, -25) : undefined}
                  calendarLabel="Choose date of birth"
                  autoComplete="off"
                />
              )}
            </Field>
            <Field label="Phone" error={errors.phone} hint={errors.phone ? undefined : country === 'IN' || !country ? 'With the country code, such as +91 98201 23456' : `With the country code, or a local ${country} number`}>
              {(f) => <Input {...f} name="phone" type="tel" inputMode="tel" autoComplete="off" maxLength={40} value={str(v.phone)} onChange={(e) => set('phone', e.target.value)} onBlur={() => { const m = phoneError(str(v.phone), country); if (m) setErrors((er) => ({ ...er, phone: m })); }} />}
            </Field>
            {minor && (
              <div className="sm:col-span-2">
                <Alert tone="warning" title={`Under ${ADULT_AGE} on the joining date (age ${ageOn(dob, joining)})`}>
                  <p className="mb-2">Employing a minor is restricted by law: hours, kinds of work and paperwork. Check what applies before you go on.</p>
                  <Checkbox
                    name="minorConfirmed"
                    checked={v.minorConfirmed === true}
                    onChange={(e) => set('minorConfirmed', e.target.checked)}
                    label="I confirm they may be employed here, and their guardian's consent or work permit is on file"
                  />
                </Alert>
                {errors.minorConfirmed && <p className="mt-1 text-xs text-danger">{errors.minorConfirmed}</p>}
              </div>
            )}
            <Field
              label="Work email"
              error={errors.workEmail}
              hint={errors.workEmail ? undefined : 'Their company address, used to sign in to SampCrew. Not their personal email.'}
            >
              {(f) => (
                <Input {...f} name="workEmail" type="email" inputMode="email" autoComplete="off" data-1p-ignore data-lpignore="true" spellCheck={false}
                  placeholder={companyDomain ? `name@${companyDomain}` : 'name@yourcompany.com'} value={str(v.workEmail)} onChange={(e) => set('workEmail', e.target.value)} />
              )}
            </Field>
            <Field label="Personal email" error={errors.personalEmail} hint="Their own address, for contact outside work">
              {(f) => <Input {...f} name="personalEmail" type="email" inputMode="email" autoComplete="off" data-1p-ignore data-lpignore="true" spellCheck={false} value={str(v.personalEmail)} onChange={(e) => set('personalEmail', e.target.value)} />}
            </Field>
            {!str(v.workEmail) && suggestedWorkEmail && (
              <p className="-mt-2 text-xs text-fg-muted sm:col-span-2">
                Work email like your colleagues&apos;?{' '}
                <button type="button" className="font-medium text-accent hover:underline" onClick={() => set('workEmail', suggestedWorkEmail)}>Use {suggestedWorkEmail}</button>
              </p>
            )}
            <Field label="Gender" error={errors.gender}>
              {(f) => (
                <Select {...f} name="gender" value={str(v.gender)} onChange={(e) => set('gender', e.target.value)}>
                  <option value="">Not recorded</option><option value="female">Female</option><option value="male">Male</option><option value="non_binary">Non-binary</option><option value="undisclosed">Prefer not to say</option>
                </Select>
              )}
            </Field>
            <div className="flex items-center gap-3 sm:col-span-2">
              {photoPreview
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={photoPreview} alt="" className="size-14 rounded-full object-cover" />
                : <span className="flex size-14 items-center justify-center rounded-full border border-dashed border-border text-fg-subtle"><Camera className="size-5" /></span>}
              <label className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-[0.8125rem] hover:bg-bg-subtle">
                {photo ? 'Change photo' : 'Add photo'}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                  aria-label="Employee photo"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    if (!PHOTO_TYPES.includes(file.type) || file.size > MAX_PHOTO) { setErrors((x) => ({ ...x, photo: 'Use a PNG, JPEG or WebP image up to 5 MB' })); return; }
                    setErrors((x) => ({ ...x, photo: '' }));
                    setPhoto(file);
                    setPhotoPreview(URL.createObjectURL(file));
                  }}
                />
              </label>
              {photo && <button type="button" className="text-xs text-fg-subtle hover:text-danger" onClick={() => { setPhoto(null); setPhotoPreview(null); }}>Remove</button>}
              <span className="text-xs text-fg-subtle">{errors.photo ? <span className="text-danger">{errors.photo}</span> : 'Optional. PNG, JPEG or WebP up to 5 MB. Saved when the hire is completed.'}</span>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <Field
              label="Joining date"
              required
              error={errors.dateOfJoining}
              hint={existing ? 'The day they first joined the company, on or before today' : dob ? `On or after ${earliestJoining(dob)}, when they turn ${MIN_WORKING_AGE}` : undefined}
            >
              {(f) => (
                <DatePicker
                  {...f}
                  name="dateOfJoining"
                  value={joining}
                  onChange={(x) => { set('dateOfJoining', x); setErrors((er) => ({ ...er, dateOfBirth: '' })); }}
                  min={dob ? earliestJoining(dob) : undefined}
                  max={existing ? today : undefined}
                  calendarLabel="Choose joining date"
                />
              )}
            </Field>
            <Field label="Legal entity" required error={errors.legalEntityId}>
              {(f) => <Select {...f} name="legalEntityId" value={entity} onChange={(e) => set('legalEntityId', e.target.value)}>{p.entities.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}
            </Field>
            {p.hrWorkspaces && (p.hrWorkspaces.options.length > 0 || !p.hrWorkspaces.central) && (
              <Field label="HR Workspace" hint="The department, branch or region that looks after this person. Its admins manage them, and they get only the modules it holds.">
                {(f) => (
                  <Select {...f} name="hrWorkspaceId" value={str(v.hrWorkspaceId)} onChange={(e) => set('hrWorkspaceId', e.target.value)}>
                    {p.hrWorkspaces!.central && <option value="">Central group (run by the company)</option>}
                    {p.hrWorkspaces!.options.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </Select>
                )}
              </Field>
            )}
            <Field
              label="Designation"
              error={errors.designationName || errors.designationId}
              hint={designationIsNew ? `"${designationText}" is new: it is added to your designations with this hire` : designationMatch ? undefined : 'Pick from the list or type any title'}
            >
              {(f) => (
                <>
                  <Input {...f} name="designation" list="hire-designations" autoComplete="off" maxLength={120} placeholder="e.g. Senior Accountant" value={str(v.designation)}
                    onChange={(e) => { set('designation', e.target.value); setErrors((er) => ({ ...er, designationName: '', designationId: '' })); }} />
                  <datalist id="hire-designations">
                    {designationSuggestions.map((x) => <option key={x.name} value={x.name} label={x.note} />)}
                  </datalist>
                </>
              )}
            </Field>
            <Field label="Employment type">
              {(f) => <Select {...f} name="employmentType" value={str(v.employmentType)} onChange={(e) => set('employmentType', e.target.value)}>{Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}
            </Field>
            <Field label="Grade" error={errors.grade}>{(f) => <Input {...f} name="grade" value={str(v.grade)} onChange={(e) => set('grade', e.target.value)} maxLength={20} />}</Field>
            <Field label="Probation (months)" error={errors.probationMonths} hint="0 confirms them straight away">{(f) => <Input {...f} name="probationMonths" type="number" min={0} max={24} value={str(v.probationMonths)} onChange={(e) => set('probationMonths', e.target.value === '' ? '' : Number(e.target.value))} />}</Field>
            {existing && (
              <>
                <h4 className="mt-1 text-xs font-semibold uppercase tracking-wide text-fg-subtle sm:col-span-2">Already working here</h4>
                <Field label="Employee code" error={errors.employeeCode} hint="The code they already have. Leave empty for the next code in your series.">
                  {(f) => <Input {...f} name="employeeCode" autoComplete="off" maxLength={40} placeholder="e.g. EMP-0042" value={str(v.employeeCode)} onChange={(e) => set('employeeCode', e.target.value)} />}
                </Field>
                {Number(v.probationMonths) > 0 && (
                  <Field
                    label="Confirmed on"
                    error={errors.confirmationDate}
                    hint={str(v.confirmationDate) ? undefined : confirmedOn ? `Empty uses ${confirmedOn}, when their probation ended` : `Empty keeps them on probation until ${probationEnd}`}
                  >
                    {(f) => <DatePicker {...f} name="confirmationDate" value={str(v.confirmationDate)} onChange={(x) => set('confirmationDate', x)} min={joining || undefined} max={today} openTo={probationEnd ?? undefined} calendarLabel="Choose confirmation date" />}
                  </Field>
                )}
                <p className="text-[0.8125rem] text-fg-muted sm:col-span-2" data-testid="existing-status">
                  {joining ? (confirmedOn && confirmedOn <= today ? `Added as a confirmed employee (confirmed ${confirmedOn}).` : `Added as on probation until ${probationEnd ?? joining}.`) : 'Choose the joining date.'}
                  {' '}No joining checklist is started unless you pick one in Attendance &amp; access.
                </p>
                {p.leavePolicies && balanceTypes.length > 0 && (
                  <fieldset className="sm:col-span-2">
                    <legend className="text-[0.8125rem] font-medium">Leave balance available today</legend>
                    <p className="mb-2 text-xs text-fg-subtle">From their previous records. SampCrew credits this year&apos;s leave as usual, then sets each balance you enter to this number. Leave a type empty to use what SampCrew works out.</p>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      {balanceTypes.map((t) => (
                        <label key={t.leaveTypeId} className="flex flex-col gap-1 text-xs text-fg-muted">
                          {t.leaveTypeName}
                          <Input aria-label={`Opening balance, ${t.leaveTypeName}`} inputMode="decimal" placeholder="days" value={str(opening[t.leaveTypeId])} onChange={(e) => setOpening(t.leaveTypeId, e.target.value)} />
                        </label>
                      ))}
                    </div>
                    {errors.openingLeaveBalances && <p className="mt-1 text-xs text-danger">{errors.openingLeaveBalances}</p>}
                  </fieldset>
                )}
                {p.availableAssets && (
                  <fieldset className="sm:col-span-2" data-testid="hire-assets">
                    <legend className="text-[0.8125rem] font-medium">Assets they already hold</legend>
                    <p className="mb-2 text-xs text-fg-subtle">Pick the company assets this person has today. Each is recorded as assigned to them from today and they are asked to acknowledge it.</p>
                    {p.availableAssets.length === 0 ? (
                      <p className="text-xs text-fg-muted">No assets are available to assign. Add them in Assets first, or assign them later from the asset.</p>
                    ) : (
                      <>
                        {p.availableAssets.length > 8 && <Input aria-label="Search available assets" placeholder="Search by code or name" value={assetQuery} onChange={(e) => setAssetQuery(e.target.value)} className="mb-2" />}
                        <div className="grid max-h-48 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
                          {p.availableAssets
                            .filter((a) => handOver.includes(a.id) || !assetQuery.trim() || `${a.assetCode} ${a.name} ${a.category ?? ''}`.toLowerCase().includes(assetQuery.trim().toLowerCase()))
                            .slice(0, 60)
                            .map((a) => (
                              <Checkbox
                                key={a.id}
                                label={`${a.assetCode} · ${a.name}`}
                                description={a.category ?? undefined}
                                checked={handOver.includes(a.id)}
                                disabled={!handOver.includes(a.id) && handOver.length >= 20}
                                onChange={(e) => setHandOver((cur) => (e.target.checked ? [...cur, a.id] : cur.filter((x) => x !== a.id)))}
                              />
                            ))}
                        </div>
                        {handOver.length > 0 && <p className="mt-1 text-xs text-fg-muted">{handOver.length} selected{handOver.length >= 20 ? ' (20 at most here)' : ''}.</p>}
                      </>
                    )}
                  </fieldset>
                )}
              </>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <Field label="Department" error={errors.departmentId}>
              {(f) => <Select {...f} name="departmentId" value={str(v.departmentId)} onChange={(e) => set('departmentId', e.target.value)}><option value="">None</option>{deptOptions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}
            </Field>
            {addInline('department')}
            <Field label="Location" error={errors.locationId}>
              {(f) => <Select {...f} name="locationId" value={str(v.locationId)} onChange={(e) => set('locationId', e.target.value)}><option value="">None</option>{locOptions.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}
            </Field>
            {addInline('location')}
            <Field label="Reports to" error={errors.managerEmployeeId} className="sm:col-span-2">
              {(f) => <Select {...f} name="managerEmployeeId" value={str(v.managerEmployeeId)} onChange={(e) => set('managerEmployeeId', e.target.value)}><option value="">No manager</option>{p.managers.map((m) => <option key={m.id} value={m.id}>{m.displayName} ({m.employeeCode})</option>)}</Select>}
            </Field>
            {manager && <p className="text-[0.8125rem] text-fg-muted sm:col-span-2">{manager.displayName} will see this person on their team and approve their leave and attendance.</p>}
          </>
        )}

        {step === 3 && (p.canPay ? (
          p.structures.length ? (
            <>
              <Field label="Salary structure" error={errors.structureId}>
                {(f) => <Select {...f} name="structureId" value={str(v.structureId)} onChange={(e) => set('structureId', e.target.value)}><option value="">Set salary later</option>{p.structures.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}
              </Field>
              {str(v.structureId) && (
                <>
                  <Field label="Annual CTC" required error={errors.annualCtc} hint={MONEY.test(str(v.annualCtc).replace(/,/g, '')) ? `About ${Math.round(Number(str(v.annualCtc).replace(/,/g, '')) / 12).toLocaleString()} a month before deductions` : undefined}>
                    {(f) => <Input {...f} name="annualCtc" inputMode="decimal" value={str(v.annualCtc)} onChange={(e) => set('annualCtc', e.target.value)} />}
                  </Field>
                  <Field label="Salary from" hint="Defaults to the joining date">{(f) => <Input {...f} name="salaryFrom" type="date" value={str(v.salaryFrom)} onChange={(e) => set('salaryFrom', e.target.value)} />}</Field>
                  {structure && <p className="text-[0.8125rem] text-fg-muted sm:col-span-2">Splits into {structure.lines.map((l) => l.name).join(', ')}. Statutory deductions follow the structure&apos;s rules.</p>}
                </>
              )}
            </>
          ) : (
            <p className="text-[0.8125rem] text-fg-muted sm:col-span-2">No salary structures yet. <Link className="text-accent hover:underline" href="/payroll/structures">Create one in Payroll</Link>, then set this person&apos;s pay from Payroll, Salaries.</p>
          )
        ) : (
          <p className="text-[0.8125rem] text-fg-muted sm:col-span-2">The payroll team sets pay after the hire. You don&apos;t have access to salaries.</p>
        ))}

        {step === 4 && (p.canDocs ? (
          <div className="space-y-3 sm:col-span-2">
            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-border px-4 py-6 text-[0.8125rem] text-fg-muted hover:bg-bg-subtle">
              <FileUp className="size-4" /> Choose files (PDF, images, Word or text; up to 10 MB in total here)
              <input
                type="file"
                multiple
                className="sr-only"
                aria-label="Attach documents"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.docx"
                onChange={(e) => {
                  const add = [...(e.target.files ?? [])].map((file) => ({ file, category: /offer/i.test(file.name) ? 'offer_letter' : /contract/i.test(file.name) ? 'contract' : 'id_proof', title: file.name.replace(/\.[^.]+$/, ''), hrOnly: false }));
                  setDocs((d) => [...d, ...add].slice(0, 10));
                  e.target.value = '';
                }}
              />
            </label>
            {errors.documents && <p className="text-xs text-danger">{errors.documents}</p>}
            {docs.length > 0 && (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {docs.map((d, i) => (
                  <li key={`${d.file.name}-${i}`} className="grid grid-cols-1 items-center gap-2 p-2 sm:grid-cols-[1fr_9rem_auto_auto]">
                    <Input value={d.title} onChange={(e) => setDocs((all) => all.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} aria-label={`Title for ${d.file.name}`} maxLength={200} />
                    <Select value={d.category} onChange={(e) => setDocs((all) => all.map((x, j) => (j === i ? { ...x, category: e.target.value } : x)))} aria-label={`Category for ${d.file.name}`}>
                      {DOCUMENT_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                    </Select>
                    <label className="flex items-center gap-1.5 text-xs text-fg-muted"><input type="checkbox" checked={d.hrOnly} onChange={(e) => setDocs((all) => all.map((x, j) => (j === i ? { ...x, hrOnly: e.target.checked } : x)))} /> HR only</label>
                    <button type="button" className="justify-self-end rounded p-1 text-fg-subtle hover:text-danger" onClick={() => setDocs((all) => all.filter((_, j) => j !== i))} aria-label={`Remove ${d.file.name}`}><X className="size-4" /></button>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-fg-subtle">Files upload when the hire is completed. They are not kept in a saved draft, so attach them again if you finish later.</p>
          </div>
        ) : (
          <p className="text-[0.8125rem] text-fg-muted sm:col-span-2">Documents are added by HR from the profile after the hire.</p>
        ))}

        {step === 5 && (
          <>
            {p.canAttendance && (
              <>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle sm:col-span-2">Attendance registration</h4>
                {shifts ? (
                  <Field label="Usual shift" error={errors.defaultShiftId} className="sm:col-span-2" hint="Rosters and day-by-day assignments still take priority">
                    {(f) => <Select {...f} name="defaultShiftId" value={str(v.defaultShiftId)} onChange={(e) => set('defaultShiftId', e.target.value)}><option value="">Location default</option>{shifts.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.startTime} to {x.endTime})</option>)}</Select>}
                  </Field>
                ) : null}
                {shifts && addInline('shift')}
                {p.devices ? (
                  <>
                    <EnrolmentRows rows={enrolments} setRows={setEnrolments} devices={p.devices} />
                    {errors.attendanceEnrolments && <p className="text-xs text-danger sm:col-span-2">{errors.attendanceEnrolments}</p>}
                  </>
                ) : (
                  <p className="text-xs text-fg-muted sm:col-span-2">Web and mobile punching work from the joining date. Attendance machine enrolment numbers are added by someone who manages the machines.</p>
                )}
              </>
            )}
            <div className="sm:col-span-2">
              <LoginModeChoice mode={loginMode} onChange={(m) => set('loginMode', m)} />
              {loginMode === 'password' && <div className="mt-3"><OwnPassword own={ownPassword} setOwn={setOwnPassword} password={password} setPassword={(x) => { setPassword(x); setErrors((e) => ({ ...e, initialPassword: '' })); }} error={errors.initialPassword} /></div>}
              {errors.workEmail && <p className="mt-1 text-xs text-danger">{errors.workEmail} <button type="button" className="text-accent hover:underline" onClick={() => setStep(0)}>Add it</button></p>}
            </div>
            {p.accessChoice && loginMode !== 'none' ? (
              <div className="rounded-lg border border-border p-4 sm:col-span-2" data-testid="hire-access">
                <AccessEditor value={access} onChange={setAccess} canGiveSuper={p.accessChoice.canGiveSuper} hrWorkspaces={p.accessChoice.hrWorkspaces} entities={p.entities} departments={p.departments} />
              </div>
            ) : (
              <p className="text-xs text-fg-muted sm:col-span-2">{loginMode === 'none' ? 'Workspace access comes with a login. Without one, they are an employee record only.' : 'Their login gets Employee Workspace access. A Super Workspace person can give more under Logins & access.'}</p>
            )}
            <Field label="Onboarding checklist" className="sm:col-span-2">
              {(f) => (
                <Select {...f} name="onboardingTemplateId" value={str(v.onboardingTemplateId)} onChange={(e) => set('onboardingTemplateId', e.target.value)}>
                  {p.templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.isDefault ? ' (default)' : ''}</option>)}
                  <option value="none">No checklist</option>
                </Select>
              )}
            </Field>
          </>
        )}

        {step === 6 && (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-[0.8125rem] sm:col-span-2 sm:grid-cols-2">
            <Summary label="Name" value={name || '—'} onEdit={() => setStep(0)} />
            <Summary label="Work email" value={str(v.workEmail) || '—'} onEdit={() => setStep(0)} />
            <Summary
              label="Joining"
              value={existing
                ? `Already working here since ${joining}${str(v.employeeCode).trim() ? ` · code ${str(v.employeeCode).trim()}` : ''} · ${confirmedOn && confirmedOn <= today ? `confirmed ${confirmedOn}` : `on probation until ${probationEnd ?? joining}`}`
                : `${joining} · ${TYPE_LABEL[str(v.employmentType)] ?? ''} · ${Number(v.probationMonths) ? `${v.probationMonths} months probation` : 'confirmed on joining'}`}
              onEdit={() => setStep(1)}
            />
            <Summary label="Entity and designation" value={`${lookup(p.entities, v.legalEntityId)} · ${designationMatch?.name ?? (designationText ? `${designationText} (new)` : '—')}`} onEdit={() => setStep(1)} />
            {dob && <Summary label="Date of birth" value={`${dob} · ${ageOn(dob, joining)} on joining${minor ? ', a minor: employment confirmed' : ''}`} onEdit={() => setStep(0)} />}
            {existing && p.availableAssets && handOver.length > 0 && <Summary label="Assets they hold" value={handOver.map((id) => p.availableAssets?.find((a) => a.id === id)?.assetCode ?? id).join(', ')} onEdit={() => setStep(1)} />}
            {existing && openingRows.length > 0 && <Summary label="Opening leave balances" value={openingRows.map((t) => `${t.leaveTypeName} ${str(opening[t.leaveTypeId]).trim()}`).join(', ')} onEdit={() => setStep(1)} />}
            <Summary label="Department and location" value={`${lookup(departments, v.departmentId)} · ${lookup(locations, v.locationId)}`} onEdit={() => setStep(2)} />
            <Summary label="Reports to" value={manager?.displayName ?? 'No manager'} onEdit={() => setStep(2)} />
            <Summary label="Pay" value={structure ? `${structure.name}, ${Number(str(v.annualCtc).replace(/,/g, '')).toLocaleString()} a year` : 'Set later'} onEdit={() => setStep(3)} />
            <Summary label="Documents" value={docs.length ? docs.map((d) => d.title || d.file.name).join(', ') : 'None'} onEdit={() => setStep(4)} />
            <Summary label="Photo" value={photo ? photo.name : 'None'} onEdit={() => setStep(0)} />
            {p.canAttendance && <Summary label="Attendance" value={`${shift ? shift.name : 'Location default shift'} · ${enrolments.filter((x) => x.deviceUserId.trim()).map((x) => x.deviceUserId.trim()).join(', ') || 'no machine enrolment'}`} onEdit={() => setStep(5)} />}
            <Summary label="Onboarding" value={template} onEdit={() => setStep(5)} />
            {loginMode !== 'none' && <Summary label="Workspace access" value={LEVEL_OPTIONS.find((l) => l.value === access.level)?.label ?? 'Employee Workspace'} onEdit={() => setStep(5)} />}
            <Summary label="SampCrew login" value={loginMode === 'invite' ? `Invitation to ${str(v.workEmail)}` : loginMode === 'password' ? `Created now for ${str(v.workEmail)} with a temporary password` : 'No login for now'} onEdit={() => setStep(5)} />
            {checkedKey === dupKey && matches === null && <p className="flex items-center gap-1.5 text-success sm:col-span-2"><Check className="size-3.5" /> No existing record matches this person.</p>}
            {checkedKey === dupKey && matches && (
              <p className="flex items-center gap-1.5 text-warning sm:col-span-2">
                <AlertTriangle className="size-3.5" /> May match {matches.map((m) => `${m.displayName} (${m.employeeCode})`).join(', ')}.{' '}
                <button type="button" className="text-accent hover:underline" onClick={() => setStep(0)}>Review</button>
              </p>
            )}
            {checkedKey !== dupKey && <p className="text-fg-subtle sm:col-span-2">Checking for an existing record…</p>}
          </dl>
        )}
      </form>
    </Dialog>
  );
}

function Summary({ label, value, onEdit }: { label: string; value: string; onEdit: () => void }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center justify-between text-xs text-fg-subtle">{label}<button type="button" className="text-accent hover:underline" onClick={onEdit} aria-label={`Edit ${label.toLowerCase()}`}>Edit</button></dt>
      <dd className="mt-0.5 truncate text-fg">{value}</dd>
    </div>
  );
}
