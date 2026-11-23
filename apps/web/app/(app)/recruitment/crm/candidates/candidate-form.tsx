'use client';
import {
  ASSESSMENT_LEVELS, CHANGE_REASONS, CONTACT_METHODS, CONTACT_TIMES, CRM_EMPLOYMENT_TYPES, EMPLOYMENT_STATUSES, GENDER_OPTIONS, INTEREST_LEVELS, NOTICE_PERIODS,
  QUALIFICATIONS, REFERENCE_RELATIONSHIPS, REFERENCE_TYPES, SENIORITY_LEVELS, SHIFT_PREFS, WORK_MODE_PREFS,
} from '@crew/contracts';
import { Alert, Button, Card, CardBody, CardHeader, Checkbox, Field, Input, Select, Textarea } from '@crew/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { FieldInput } from '@/components/custom-fields-card';
import { useMfaRetry } from '@/components/mfa-step-up';
import type { ActionResult } from '@/lib/api';
import { createCandidateAction, formFieldsAction, updateCandidateAction } from '../crm-actions';
import type { CrmContext, CrmField } from '../crm-types';

type V = Record<string, string>;
type Ref = { type: string; name: string; phone: string; email: string; company: string; relationship: string; details: string };
type Pair = readonly (readonly [string, string, ...unknown[]])[];

const LISTS = ['languages', 'primarySkills', 'secondarySkills', 'technicalSkills', 'softSkills', 'certifications', 'tags'];
const PREF_LISTS = ['industries', 'departments', 'roles', 'locations', 'employmentTypes'];
const PERSONAL = ['firstName', 'middleName', 'lastName', 'gender', 'dateOfBirth', 'nationality', 'email', 'alternateEmail', 'phone', 'alternatePhone', 'whatsapp', 'address', 'city', 'state', 'country', 'postalCode', 'contactMethod', 'contactTime', 'currentLocation'];
const PROFESSIONAL = ['profession', 'currentTitle', 'currentCompany', 'previousCompany', 'industry', 'department', 'jobRole', 'employmentStatus', 'employmentType', 'seniority', 'teamFunction', 'highestQualification', 'specialization', 'institution', 'summary', 'source', 'sourceDetail'];
const COMP = ['currency', 'basis', 'currentCtc', 'currentFixed', 'currentVariable', 'currentMonthly', 'expectedCtc', 'expectedFixed', 'expectedVariable', 'expectedMonthly', 'minimumAcceptable'];
const NOTICE = ['period', 'value', 'unit', 'lastWorkingDay', 'availableFrom'];
const PREFS = ['designation', 'workMode', 'shift', 'changeReason', 'objective', 'other'];
const INSIGHTS = ['reasonChange', 'reasonLeaving', 'expectations', 'preferences', 'communication', 'professional', 'interest', 'salaryNotes', 'noticeNotes', 'interviewAvailability', 'observations', 'general', 'additional'];
const LINKS = ['linkedin', 'portfolio', 'website', 'github', 'behance', 'dribbble', 'blog'];
const BOOLS = ['negotiable', 'servingNotice', 'immediateJoiner', 'relocate', 'remote'];

const str = (x: unknown) => (x === null || x === undefined ? '' : Array.isArray(x) ? x.join(', ') : String(x));
const listOf = (s: string | undefined) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const blank = (s: string | undefined) => (s && s.trim() ? s.trim() : null);
const emptyRef = (): Ref => ({ type: 'employee_referral', name: '', phone: '', email: '', company: '', relationship: '', details: '' });

/** The form's values from a stored candidate (the profile view), flattened into strings. */
function initialValues(c: Record<string, unknown> | undefined, ctx: CrmContext): V {
  const v: V = { currency: 'INR', basis: 'annual', source: 'manual', stage: 'new' };
  if (!c) return v;
  for (const k of [...PERSONAL, ...PROFESSIONAL, ...LISTS, 'stage', 'assignedRecruiterMembershipId', 'hrWorkspaceId']) v[k] = str(c[k]);
  v.country = str(c.country);
  v.graduationYear = str(c.graduationYear);
  const exp = (m: unknown) => (typeof m === 'number' ? [String(Math.floor(m / 12)), String(m % 12)] : ['', '']);
  [v.expYears, v.expMonths] = exp(c.totalExperienceMonths);
  [v.relYears, v.relMonths] = exp(c.relevantExperienceMonths);
  const sec = (name: string, keys: string[], prefix: string) => {
    const o = (c[name] ?? {}) as Record<string, unknown>;
    for (const k of keys) v[`${prefix}.${k}`] = str(o[k]);
    for (const k of BOOLS) if (o[k] !== undefined && o[k] !== null) v[`${prefix}.${k}`] = o[k] ? 'yes' : 'no';
  };
  sec('compensation', COMP, 'comp');
  sec('notice', NOTICE, 'notice');
  sec('preferences', [...PREFS, ...PREF_LISTS], 'pref');
  sec('insights', INSIGHTS, 'ins');
  sec('links', LINKS, 'link');
  v.currency = v['comp.currency'] || 'INR';
  v.basis = v['comp.basis'] || 'annual';
  void ctx;
  return v;
}

/** The request body for the API from the form's values. */
function bodyOf(v: V, sensitive: boolean, isNew: boolean) {
  const b: Record<string, unknown> = {};
  for (const k of PERSONAL) if (sensitive || !['gender', 'dateOfBirth', 'nationality'].includes(k)) b[k] = blank(v[k]);
  b.firstName = v.firstName?.trim() ?? '';
  b.lastName = v.lastName?.trim() ?? '';
  for (const k of PROFESSIONAL) b[k] = blank(v[k]);
  for (const k of LISTS) b[k] = listOf(v[k]);
  const months = (y?: string, m?: string) => (y || m ? Math.round((Number(y) || 0) * 12 + (Number(m) || 0)) : null);
  b.totalExperienceMonths = months(v.expYears, v.expMonths);
  b.relevantExperienceMonths = months(v.relYears, v.relMonths);
  b.graduationYear = v.graduationYear ? Number(v.graduationYear) : null;
  const bool = (s?: string) => (s === 'yes' ? true : s === 'no' ? false : null);
  const sec = (keys: string[], prefix: string, extra: Record<string, unknown> = {}) => {
    const o: Record<string, unknown> = {};
    for (const k of keys) o[k] = blank(v[`${prefix}.${k}`]);
    return { ...o, ...extra };
  };
  b.compensation = { ...sec(COMP.filter((k) => k !== 'currency' && k !== 'basis'), 'comp'), currency: v.currency || 'INR', basis: v.basis || 'annual', negotiable: bool(v['comp.negotiable']) };
  b.notice = {
    period: blank(v['notice.period']), value: v['notice.value'] ? Number(v['notice.value']) : null, unit: blank(v['notice.unit']),
    lastWorkingDay: blank(v['notice.lastWorkingDay']), availableFrom: blank(v['notice.availableFrom']), servingNotice: bool(v['notice.servingNotice']), immediateJoiner: bool(v['notice.immediateJoiner']),
  };
  b.preferences = { ...sec(PREFS, 'pref'), ...Object.fromEntries(PREF_LISTS.map((k) => [k, listOf(v[`pref.${k}`])])), relocate: bool(v['pref.relocate']), remote: bool(v['pref.remote']) };
  b.insights = sec(INSIGHTS, 'ins');
  b.links = { ...sec(LINKS, 'link'), other: [] };
  b.assignedRecruiterMembershipId = blank(v.assignedRecruiterMembershipId);
  if (isNew) {
    b.stage = v.stage || 'new';
    if (v.hrWorkspaceId !== undefined) b.hrWorkspaceId = v.hrWorkspaceId === '' ? null : v.hrWorkspaceId;
    if (v.remark?.trim()) b.remark = v.remark.trim();
  }
  return b;
}

export function CandidateForm({ ctx, candidate, customValues }: { ctx: CrmContext; candidate?: Record<string, unknown> & { id: string; sensitiveHidden?: boolean }; customValues?: Record<string, unknown> }) {
  const router = useRouter();
  const withMfa = useMfaRetry();
  const isNew = !candidate;
  const sensitive = isNew ? ctx.caps.includes('sensitive') : !candidate.sensitiveHidden;
  const [v, setV] = useState<V>(() => ({ ...initialValues(candidate, ctx), ...(isNew && ctx.level === 'hr' && ctx.workspaces[0] ? { hrWorkspaceId: ctx.workspaces[0].key === 'central' ? '' : ctx.workspaces[0].key } : {}), ...(isNew && ctx.level === 'super' ? { hrWorkspaceId: '' } : {}) }));
  const [refs, setRefs] = useState<Ref[]>([]);
  const [fields, setFields] = useState<CrmField[]>([]);
  const [cf, setCf] = useState<Record<string, unknown>>(customValues ?? {});
  const [lawful, setLawful] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<{ text: string; duplicate?: boolean } | null>(null);
  const [pending, start] = useTransition();
  const set = (k: string) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));
  const owner = isNew ? (v.hrWorkspaceId || null) : ((candidate.hrWorkspaceId as string | null) ?? null);

  useEffect(() => {
    let live = true;
    formFieldsAction(owner).then((r) => { if (live && r.ok) setFields((r.data ?? []) as CrmField[]); });
    return () => { live = false; };
  }, [owner]);

  const text = (k: string, label: string, opts: { type?: string; placeholder?: string; required?: boolean; hint?: string; wide?: boolean } = {}) => (
    <Field label={label} required={opts.required} hint={opts.hint} error={errors[k]} className={opts.wide ? 'sm:col-span-2' : ''}>
      {(p) => <Input {...p} type={opts.type ?? 'text'} value={v[k] ?? ''} placeholder={opts.placeholder} onChange={set(k)} />}
    </Field>
  );
  const area = (k: string, label: string, hint?: string) => (
    <Field label={label} hint={hint} error={errors[k]} className="sm:col-span-2">{(p) => <Textarea {...p} rows={3} value={v[k] ?? ''} onChange={set(k)} />}</Field>
  );
  const pick = (k: string, label: string, list: Pair | { value: string; label: string }[], opts: { required?: boolean; none?: string } = {}) => (
    <Field label={label} required={opts.required} error={errors[k]}>
      {(p) => (
        <Select {...p} value={v[k] ?? ''} onChange={set(k)}>
          <option value="">{opts.none ?? 'Choose…'}</option>
          {(list as (readonly [string, string, ...unknown[]] | { value: string; label: string })[]).map((o) => Array.isArray(o) ? <option key={o[0]} value={o[0]}>{o[1]}</option> : <option key={(o as { value: string }).value} value={(o as { value: string }).value}>{(o as { label: string }).label}</option>)}
        </Select>
      )}
    </Field>
  );
  const yesNo = (k: string, label: string) => pick(k, label, [['yes', 'Yes'], ['no', 'No']] as const, { none: 'Not asked' });

  const submit = (allowPhoneDuplicate = false) => start(async () => {
    setProblem(null);
    setErrors({});
    const body = bodyOf(v, sensitive, isNew);
    const custom = Object.fromEntries(fields.filter((f) => f.type !== 'file').map((f) => [f.key, cf[f.key] ?? null]));
    let r: ActionResult<unknown>;
    if (isNew) {
      r = await withMfa(() => createCandidateAction({
        ...body, customFields: custom, lawfulBasisConfirmed: lawful || undefined, allowPhoneDuplicate,
        references: refs.filter((x) => x.name || x.phone || x.email || x.company).map((x) => ({ ...x, name: blank(x.name), phone: blank(x.phone), email: blank(x.email), company: blank(x.company), relationship: blank(x.relationship), details: blank(x.details) })),
      }));
    } else {
      r = await withMfa(() => updateCandidateAction(candidate.id, { ...body, customFields: custom }));
    }
    if (!r.ok) {
      const fe = Object.fromEntries(Object.entries(r.fieldErrors ?? {}).map(([k, m]) => [k.replace(/^customFields\./, 'cf.').replace(/^compensation\./, 'comp.').replace(/^preferences\./, 'pref.').replace(/^insights\./, 'ins.').replace(/^links\./, 'link.'), m]));
      setErrors(fe);
      setProblem({ text: Object.keys(fe).length ? `${r.message}. Check the highlighted fields.` : r.message, duplicate: r.code === 'possible_duplicate' });
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const id = isNew ? (r.data as { id: string }).id : candidate.id;
    router.push(`/recruitment/crm/candidates/${id}?saved=${isNew ? 'added' : 'updated'}`);
    router.refresh();
  });

  return (
    <form className="grid gap-6" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
      {problem && (
        <Alert tone="danger">
          {problem.text}
          {problem.duplicate && <div className="mt-2"><Button type="button" size="sm" variant="secondary" onClick={() => submit(true)}>Add anyway, this is someone else</Button></div>}
        </Alert>
      )}

      <Card>
        <CardHeader title="A. Personal details" description="Name and how to reach the candidate. An email address or a phone number is needed." />
        <CardBody className="grid gap-4 sm:grid-cols-3">
          {text('firstName', 'First name', { required: true })}
          {text('middleName', 'Middle name')}
          {text('lastName', 'Last name')}
          {text('email', 'Email', { type: 'email' })}
          {text('phone', 'Mobile number', { type: 'tel', placeholder: '+91 98200 11122' })}
          {text('whatsapp', 'WhatsApp number', { type: 'tel' })}
          {text('alternateEmail', 'Alternate email', { type: 'email' })}
          {text('alternatePhone', 'Alternate phone', { type: 'tel' })}
          {sensitive ? (
            <>
              {pick('gender', 'Gender', GENDER_OPTIONS)}
              {text('dateOfBirth', 'Date of birth', { type: 'date' })}
              {text('nationality', 'Nationality')}
            </>
          ) : (
            <p className="text-xs text-fg-subtle sm:col-span-3">Gender, date of birth and nationality are kept private and are not shown to your HR Workspace.</p>
          )}
          {text('currentLocation', 'Current location', { placeholder: 'Area, city' })}
          {text('city', 'City')}
          {text('state', 'State')}
          {text('country', 'Country code', { placeholder: 'IN', hint: 'Two letters, for example IN, AE, GB' })}
          {text('postalCode', 'Postal code')}
          {text('address', 'Address', { wide: false })}
          {pick('contactMethod', 'Preferred contact method', CONTACT_METHODS)}
          {pick('contactTime', 'Best time to contact', CONTACT_TIMES)}
          {text('languages', 'Languages', { placeholder: 'English, Hindi' })}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="B. Professional details" description="Current work, experience, skills and education." />
        <CardBody className="grid gap-4 sm:grid-cols-3">
          {text('profession', 'Current profession', { placeholder: 'Software engineer' })}
          {text('currentTitle', 'Current job title')}
          {text('currentCompany', 'Current company')}
          {text('previousCompany', 'Previous company')}
          {text('industry', 'Industry')}
          {text('department', 'Department')}
          {text('jobRole', 'Job role')}
          {text('teamFunction', 'Team or function')}
          {pick('seniority', 'Seniority', SENIORITY_LEVELS)}
          <Field label="Total experience" hint="Years and months" error={errors.totalExperienceMonths}>
            {(p) => <div className="flex gap-2"><Input {...p} inputMode="numeric" placeholder="Years" value={v.expYears ?? ''} onChange={set('expYears')} /><Input aria-label="Total experience months" inputMode="numeric" placeholder="Months" value={v.expMonths ?? ''} onChange={set('expMonths')} /></div>}
          </Field>
          <Field label="Relevant experience" hint="Years and months" error={errors.relevantExperienceMonths}>
            {(p) => <div className="flex gap-2"><Input {...p} inputMode="numeric" placeholder="Years" value={v.relYears ?? ''} onChange={set('relYears')} /><Input aria-label="Relevant experience months" inputMode="numeric" placeholder="Months" value={v.relMonths ?? ''} onChange={set('relMonths')} /></div>}
          </Field>
          {pick('employmentStatus', 'Employment status', EMPLOYMENT_STATUSES)}
          {pick('employmentType', 'Employment type', CRM_EMPLOYMENT_TYPES)}
          {text('primarySkills', 'Primary skills', { placeholder: 'Comma separated', wide: true })}
          {text('secondarySkills', 'Secondary skills', { placeholder: 'Comma separated' })}
          {text('technicalSkills', 'Technical skills', { placeholder: 'Comma separated' })}
          {text('softSkills', 'Soft skills', { placeholder: 'Comma separated' })}
          {text('certifications', 'Certifications', { placeholder: 'Comma separated' })}
          {pick('highestQualification', 'Highest qualification', QUALIFICATIONS)}
          {text('specialization', 'Specialization')}
          {text('institution', 'University or institution')}
          {text('graduationYear', 'Year of passing', { placeholder: '2018' })}
          {area('summary', 'Professional summary')}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="C. Compensation and notice period" description="Current and expected pay, and when they can join." />
        <CardBody className="grid gap-4 sm:grid-cols-3">
          {text('currency', 'Currency', { placeholder: 'INR' })}
          {pick('basis', 'Pay is', [['annual', 'Annual CTC'], ['monthly', 'Monthly salary'], ['hourly', 'Hourly rate']] as const)}
          {yesNo('comp.negotiable', 'Expected pay negotiable')}
          {text('comp.currentCtc', 'Current CTC', { placeholder: '1200000' })}
          {text('comp.currentFixed', 'Current fixed')}
          {text('comp.currentVariable', 'Current variable')}
          {text('comp.expectedCtc', 'Expected CTC', { placeholder: '1600000' })}
          {text('comp.expectedFixed', 'Expected fixed')}
          {text('comp.expectedVariable', 'Expected variable')}
          {text('comp.minimumAcceptable', 'Minimum acceptable')}
          {pick('notice.period', 'Notice period', NOTICE_PERIODS)}
          {v['notice.period'] === 'custom' && (
            <Field label="Custom notice" error={errors['notice.value']}>
              {(p) => <div className="flex gap-2"><Input {...p} inputMode="numeric" value={v['notice.value'] ?? ''} onChange={set('notice.value')} /><Select aria-label="Notice unit" value={v['notice.unit'] ?? ''} onChange={set('notice.unit')}><option value="">Unit…</option><option value="days">Days</option><option value="weeks">Weeks</option><option value="months">Months</option></Select></div>}
            </Field>
          )}
          {yesNo('notice.servingNotice', 'Serving notice')}
          {yesNo('notice.immediateJoiner', 'Immediate joiner')}
          {text('notice.lastWorkingDay', 'Last working day', { type: 'date' })}
          {text('notice.availableFrom', 'Available from', { type: 'date' })}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="D. Job preferences" description="What the candidate is looking for." />
        <CardBody className="grid gap-4 sm:grid-cols-3">
          {text('pref.roles', 'Preferred roles', { placeholder: 'Comma separated' })}
          {text('pref.designation', 'Preferred designation')}
          {text('pref.locations', 'Preferred locations', { placeholder: 'Comma separated' })}
          {text('pref.industries', 'Preferred industries', { placeholder: 'Comma separated' })}
          {text('pref.departments', 'Preferred departments', { placeholder: 'Comma separated' })}
          {pick('pref.workMode', 'Work mode', WORK_MODE_PREFS)}
          {pick('pref.shift', 'Shift', SHIFT_PREFS)}
          {yesNo('pref.relocate', 'Willing to relocate')}
          {pick('pref.changeReason', 'Main reason for change', CHANGE_REASONS)}
          {area('pref.objective', 'Career objective')}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="E. Recruiter insights" description="The recruiter’s assessment. Remarks you add later are kept as dated notes on the profile." />
        <CardBody className="grid gap-4 sm:grid-cols-3">
          {pick('ins.communication', 'Communication', ASSESSMENT_LEVELS)}
          {pick('ins.professional', 'Professional assessment', ASSESSMENT_LEVELS)}
          {pick('ins.interest', 'Interest level', INTEREST_LEVELS)}
          {area('ins.reasonChange', 'Reason for looking for a change')}
          {text('ins.interviewAvailability', 'Availability for interview')}
          {area('ins.reasonLeaving', 'Reason for leaving current organization')}
          {area('ins.expectations', 'Career expectations')}
          {area('ins.salaryNotes', 'Salary discussion')}
          {area('ins.noticeNotes', 'Notice period discussion')}
          {area('ins.observations', 'Recruiter’s observations')}
          {isNew && <Field label="First remark" hint="Saved as a dated general remark" className="sm:col-span-3">{(p) => <Textarea {...p} rows={3} value={v.remark ?? ''} onChange={set('remark')} />}</Field>}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Professional links" description="LinkedIn, portfolio and other profiles. Addresses are saved but never opened by SampCrew." />
        <CardBody className="grid gap-4 sm:grid-cols-3">
          {text('link.linkedin', 'LinkedIn', { placeholder: 'https://www.linkedin.com/in/…' })}
          {text('link.portfolio', 'Portfolio')}
          {text('link.website', 'Personal website')}
          {text('link.github', 'GitHub')}
          {text('link.behance', 'Behance')}
          {text('link.dribbble', 'Dribbble')}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Source and assignment" description="Where the candidate came from, their stage and recruiter." />
        <CardBody className="grid gap-4 sm:grid-cols-3">
          {pick('source', 'Source', ctx.sources.filter((s) => s.active || s.key === v.source).map((s) => ({ value: s.key, label: s.label })))}
          {text('sourceDetail', 'Source detail', { placeholder: 'Naukri job 4471, campus drive …' })}
          {isNew && pick('stage', 'Stage', ctx.stages.filter((s) => s.active).map((s) => ({ value: s.key, label: s.label })), { none: 'New Candidate' })}
          {pick('assignedRecruiterMembershipId', 'Assigned recruiter', ctx.recruiters.map((r) => ({ value: r.membershipId, label: r.name })), { none: 'Unassigned' })}
          {isNew && ctx.level === 'super' && pick('hrWorkspaceId', 'Belongs to', ctx.hrWorkspaces.map((w) => ({ value: w.id, label: w.name })), { none: 'Super Workspace (company-wide)' })}
          {isNew && ctx.level === 'hr' && ctx.workspaces.length > 1 && pick('hrWorkspaceId', 'HR Workspace', ctx.workspaces.map((w) => ({ value: w.key === 'central' ? '' : w.key, label: w.name })))}
          {text('tags', 'Tags', { placeholder: 'Comma separated' })}
        </CardBody>
      </Card>

      {isNew && (
        <Card>
          <CardHeader title="References" description="Who referred the candidate or where the reference came from." action={<Button type="button" size="sm" variant="secondary" onClick={() => setRefs([...refs, emptyRef()])}><Plus className="size-3.5" /> Add reference</Button>} />
          <CardBody className="grid gap-4">
            {refs.length === 0 && <p className="text-[0.8125rem] text-fg-muted">No references added. You can also add them later from the profile.</p>}
            {refs.map((r, i) => {
              const up = (k: keyof Ref) => (e: { target: { value: string } }) => setRefs(refs.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)));
              return (
                <div key={i} className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-3">
                  <Field label="Reference type">{(p) => <Select {...p} value={r.type} onChange={up('type')}>{REFERENCE_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
                  <Field label="Reference name">{(p) => <Input {...p} value={r.name} onChange={up('name')} />}</Field>
                  <Field label="Relationship">{(p) => <Select {...p} value={r.relationship} onChange={up('relationship')}><option value="">Choose…</option>{REFERENCE_RELATIONSHIPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
                  <Field label="Reference phone">{(p) => <Input {...p} type="tel" value={r.phone} onChange={up('phone')} />}</Field>
                  <Field label="Reference email">{(p) => <Input {...p} type="email" value={r.email} onChange={up('email')} />}</Field>
                  <Field label="Reference company">{(p) => <Input {...p} value={r.company} onChange={up('company')} />}</Field>
                  <Field label="Reference details" className="sm:col-span-2">{(p) => <Input {...p} value={r.details} onChange={up('details')} />}</Field>
                  <div className="flex items-end"><Button type="button" size="sm" variant="ghost" onClick={() => setRefs(refs.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /> Remove</Button></div>
                </div>
              );
            })}
          </CardBody>
        </Card>
      )}

      {fields.length > 0 && (
        <Card>
          <CardHeader title="Additional details" description="Fields your organisation added to the candidate form." />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            {fields.filter((f) => f.type !== 'file' || !isNew).map((f) => (
              <FieldInput key={f.key} r={{ field: f, value: cf[f.key] ?? null, text: '', editable: true, fits: true }} value={cf[f.key] ?? null} onChange={(x) => setCf((c) => ({ ...c, [f.key]: x }))} error={errors[`cf.${f.key}`]} entity="candidate" recordId={candidate?.id ?? ''} />
            ))}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody className="grid gap-4">
          {isNew && (
            <Checkbox
              label="The candidate agreed to share these details with us for recruitment"
              description="Required by data-protection rules. Personal details are erased after the retention period if nothing is in progress."
              checked={lawful}
              onChange={(e) => setLawful(e.target.checked)}
            />
          )}
          {errors.lawfulBasisConfirmed && <p className="text-xs text-danger">{errors.lawfulBasisConfirmed}</p>}
          <div className="flex gap-2">
            <Button type="submit" loading={pending}>{isNew ? 'Add candidate' : 'Save changes'}</Button>
            <Button type="button" variant="ghost" onClick={() => router.back()}>Cancel</Button>
          </div>
        </CardBody>
      </Card>
    </form>
  );
}
