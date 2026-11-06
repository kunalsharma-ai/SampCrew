'use client';
import { DOCUMENT_CATEGORIES } from '@crew/contracts';
import { Alert, Button, Checkbox, Dialog, Field, Input, Select, cn } from '@crew/ui';
import { AlertTriangle, Camera, Check, FileUp, Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import type { Department, Designation, Employee, LegalEntity, Location, OnboardingTemplate } from '@/lib/types';
import type { Structure } from '../payroll/types';
import { type DeviceOption, EnrolmentRows, LoginModeChoice, OwnPassword, type ShiftOption } from './[id]/profile-extras';
import { completeHireAction, createDepartmentAction, createDesignationAction, createLocationAction, createShiftAction, type DraftData, duplicateCheckAction, saveHireDraftAction } from './actions';
import type { HireDone } from './employees-view';

export interface EmployeeDraft { id: string; step: number; data: DraftData; updatedAt: string }

export const HIRE_STEPS = ['Personal details', 'Employment', 'Department & reporting', 'Compensation', 'Documents', 'Attendance & access', 'Review'] as const;

/** Which step holds each field, so a server error can take HR straight to it. */
const FIELD_STEP: Record<string, number> = {
  firstName: 0, lastName: 0, preferredName: 0, workEmail: 0, personalEmail: 0, phone: 0, dateOfBirth: 0, gender: 0,
  dateOfJoining: 1, legalEntityId: 1, employmentType: 1, designationId: 1, grade: 1, probationMonths: 1,
  departmentId: 2, locationId: 2, managerEmployeeId: 2,
  structureId: 3, annualCtc: 3, salaryFrom: 3,
  inviteToCrew: 5, loginMode: 5, initialPassword: 5, defaultShiftId: 5, attendanceEnrolments: 5, onboardingTemplateId: 5, membershipId: 5,
};
const EMPLOYEE_FIELDS = ['firstName', 'lastName', 'preferredName', 'workEmail', 'personalEmail', 'phone', 'dateOfBirth', 'gender', 'dateOfJoining', 'legalEntityId', 'employmentType', 'designationId', 'grade', 'departmentId', 'locationId', 'managerEmployeeId'];
const CATEGORY_LABEL: Record<string, string> = { id_proof: 'ID proof', address_proof: 'Address proof', contract: 'Contract', offer_letter: 'Offer letter', policy: 'Policy', certificate: 'Certificate', tax: 'Tax', other: 'Other' };
const TYPE_LABEL: Record<string, string> = { full_time: 'Full time', part_time: 'Part time', contract: 'Contract', intern: 'Intern', temporary: 'Temporary' };
const MAX_UPLOAD = 10 * 1024 * 1024;
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_PHOTO = 5 * 1024 * 1024;
const strongEnough = (pw: string) => pw.length >= 12 && [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length >= 3;
type LoginMode = 'none' | 'invite' | 'password';
type Enrolment = { deviceUserId: string; deviceId: string };

type Match = { id: string; displayName: string; employeeCode: string; status: string; departmentName: string | null; reasons: string[] };
type Doc = { file: File; category: string; title: string; hrOnly: boolean };

type Kind = 'designation' | 'department' | 'location' | 'shift';

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
    dateOfJoining: today, legalEntityId: p.entities[0]?.id ?? '', employmentType: 'full_time', probationMonths: 6,
    onboardingTemplateId: p.templates.find((t) => t.isDefault)?.id ?? '', loginMode: 'none',
  });
  const [v, setV] = useState<DraftData>(blank);
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
    }
    if (s === 1) {
      if (!str(v.dateOfJoining)) e.dateOfJoining = 'Choose the joining date';
      if (!entity) e.legalEntityId = 'Choose the legal entity';
      const pm = Number(v.probationMonths);
      if (!Number.isInteger(pm) || pm < 0 || pm > 24) e.probationMonths = 'Use 0 to 24 months';
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
    if (loginMode === 'password' && ownPassword) employee.initialPassword = password;
    if (str(v.defaultShiftId)) employee.defaultShiftId = str(v.defaultShiftId);
    const enrol = enrolments.filter((x) => x.deviceUserId.trim()).map((x) => ({ deviceUserId: x.deviceUserId.trim(), deviceId: x.deviceId || null }));
    if (enrol.length) employee.attendanceEnrolments = enrol;
    for (const k of EMPLOYEE_FIELDS) { const x = str(v[k]).trim(); if (x) employee[k] = x; }
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
  const FIELD_OF: Record<Kind, string> = { designation: 'designationId', department: 'departmentId', location: 'locationId', shift: 'defaultShiftId' };
  const addOption = (kind: Kind) => {
    const n = newName.trim();
    if (!n) return;
    // A name already on the list is simply chosen, not added twice.
    const list: { id: string; name: string }[] = kind === 'designation' ? designations : kind === 'department' ? deptOptions : kind === 'location' ? locOptions : (shifts ?? []);
    const same = list.find((x) => x.name.trim().toLowerCase() === n.toLowerCase());
    if (same) { set(FIELD_OF[kind], same.id); setErrors((e) => ({ ...e, [FIELD_OF[kind]]: '' })); setAdding(null); setNewName(''); return; }
    start(async () => {
      const ent = p.entities.find((x) => x.id === entity);
      const r = kind === 'designation' ? await createDesignationAction(n)
        : kind === 'department' ? await createDepartmentAction(n, null)
          : kind === 'location' ? await createLocationAction(n, entity, ent?.countryCode ?? 'IN', ent?.timezone ?? 'Asia/Kolkata')
            : await createShiftAction(n, shiftTimes.start, shiftTimes.end);
      if (!r.ok || !r.data) { setErrors((e) => ({ ...e, [FIELD_OF[kind]]: r.ok ? 'Could not add it' : (Object.values(r.fieldErrors ?? {})[0] ?? r.message) })); return; }
      const row = r.data as { id: string; name: string; code?: string; startTime?: string; endTime?: string };
      if (kind === 'designation') setDesignations((d) => [...d, { id: row.id, name: row.name, code: null, level: null, employeeCount: 0 }]);
      else if (kind === 'department') setDepartments((d) => [...d, { id: row.id, name: row.name, code: null, parentId: null, legalEntityId: null, businessUnitId: null, headMembershipId: null, memberCount: 0 }]);
      else if (kind === 'location') setLocations((l) => [...l, { id: row.id, name: row.name, code: null, kind: 'office', legalEntityId: entity, timezone: ent?.timezone ?? '', city: null, region: null, countryCode: ent?.countryCode ?? '', latitude: null, longitude: null, geofenceRadiusM: null, addressLine: null, postalCode: null }]);
      else setShifts((x) => [...(x ?? []), { id: row.id, name: row.name, code: row.code ?? '', startTime: row.startTime ?? shiftTimes.start, endTime: row.endTime ?? shiftTimes.end }]);
      set(FIELD_OF[kind], row.id);
      setErrors((e) => ({ ...e, [FIELD_OF[kind]]: '' }));
      setAdding(null);
      setNewName('');
    });
  };
  const PLACEHOLDER: Record<Kind, string> = { designation: 'Senior Accountant', department: 'Customer Success', location: 'Pune plant', shift: 'Morning shift' };
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
            <Field label="First name" required error={errors.firstName}>{(f) => <Input {...f} name="firstName" value={str(v.firstName)} onChange={(e) => set('firstName', e.target.value)} maxLength={80} autoFocus />}</Field>
            <Field label="Last name" error={errors.lastName}>{(f) => <Input {...f} name="lastName" value={str(v.lastName)} onChange={(e) => set('lastName', e.target.value)} maxLength={80} />}</Field>
            <Field label="Preferred name" hint="Shown across SampCrew instead of the first name">{(f) => <Input {...f} name="preferredName" value={str(v.preferredName)} onChange={(e) => set('preferredName', e.target.value)} maxLength={80} />}</Field>
            <Field label="Date of birth" error={errors.dateOfBirth}>{(f) => <Input {...f} name="dateOfBirth" type="date" value={str(v.dateOfBirth)} onChange={(e) => set('dateOfBirth', e.target.value)} max={today} />}</Field>
            <Field label="Work email" error={errors.workEmail} hint="Needed to invite them to SampCrew">{(f) => <Input {...f} name="workEmail" type="email" value={str(v.workEmail)} onChange={(e) => set('workEmail', e.target.value)} />}</Field>
            <Field label="Personal email" error={errors.personalEmail}>{(f) => <Input {...f} name="personalEmail" type="email" value={str(v.personalEmail)} onChange={(e) => set('personalEmail', e.target.value)} />}</Field>
            <Field label="Phone" error={errors.phone}>{(f) => <Input {...f} name="phone" type="tel" value={str(v.phone)} onChange={(e) => set('phone', e.target.value)} />}</Field>
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
            <Field label="Joining date" required error={errors.dateOfJoining}>{(f) => <Input {...f} name="dateOfJoining" type="date" value={str(v.dateOfJoining)} onChange={(e) => set('dateOfJoining', e.target.value)} />}</Field>
            <Field label="Legal entity" required error={errors.legalEntityId}>
              {(f) => <Select {...f} name="legalEntityId" value={entity} onChange={(e) => set('legalEntityId', e.target.value)}>{p.entities.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}
            </Field>
            <Field label="Designation" error={errors.designationId}>
              {(f) => <Select {...f} name="designationId" value={str(v.designationId)} onChange={(e) => set('designationId', e.target.value)}><option value="">None</option>{designations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}
            </Field>
            {!designations.length && <p className="text-xs text-fg-muted sm:col-span-2">No designations yet.{p.canManageOrg ? ' Add one here, or pick a ready-made list in Organization structure, Designations.' : ' Ask an administrator to add them in Organization structure.'}</p>}
            {addInline('designation')}
            <Field label="Employment type">
              {(f) => <Select {...f} name="employmentType" value={str(v.employmentType)} onChange={(e) => set('employmentType', e.target.value)}>{Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}
            </Field>
            <Field label="Grade" error={errors.grade}>{(f) => <Input {...f} name="grade" value={str(v.grade)} onChange={(e) => set('grade', e.target.value)} maxLength={20} />}</Field>
            <Field label="Probation (months)" error={errors.probationMonths} hint="0 confirms them straight away">{(f) => <Input {...f} name="probationMonths" type="number" min={0} max={24} value={str(v.probationMonths)} onChange={(e) => set('probationMonths', e.target.value === '' ? '' : Number(e.target.value))} />}</Field>
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
            <Summary label="Joining" value={`${str(v.dateOfJoining)} · ${TYPE_LABEL[str(v.employmentType)] ?? ''} · ${Number(v.probationMonths) ? `${v.probationMonths} months probation` : 'confirmed on joining'}`} onEdit={() => setStep(1)} />
            <Summary label="Entity and designation" value={`${lookup(p.entities, v.legalEntityId)} · ${lookup(designations, v.designationId)}`} onEdit={() => setStep(1)} />
            <Summary label="Department and location" value={`${lookup(departments, v.departmentId)} · ${lookup(locations, v.locationId)}`} onEdit={() => setStep(2)} />
            <Summary label="Reports to" value={manager?.displayName ?? 'No manager'} onEdit={() => setStep(2)} />
            <Summary label="Pay" value={structure ? `${structure.name}, ${Number(str(v.annualCtc).replace(/,/g, '')).toLocaleString()} a year` : 'Set later'} onEdit={() => setStep(3)} />
            <Summary label="Documents" value={docs.length ? docs.map((d) => d.title || d.file.name).join(', ') : 'None'} onEdit={() => setStep(4)} />
            <Summary label="Photo" value={photo ? photo.name : 'None'} onEdit={() => setStep(0)} />
            {p.canAttendance && <Summary label="Attendance" value={`${shift ? shift.name : 'Location default shift'} · ${enrolments.filter((x) => x.deviceUserId.trim()).map((x) => x.deviceUserId.trim()).join(', ') || 'no machine enrolment'}`} onEdit={() => setStep(5)} />}
            <Summary label="Onboarding" value={template} onEdit={() => setStep(5)} />
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
