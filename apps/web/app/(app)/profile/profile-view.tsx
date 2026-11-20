'use client';
import { ACCOUNT_TYPES, BLOOD_GROUPS, EDUCATION_LEVEL_LABELS, EDUCATION_LEVELS, MARITAL_STATUSES, PROFILE_SECTION_LABELS } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardHeader, Checkbox, cn, DatePicker, Field, Input, Select, type Tone } from '@crew/ui';
import { Download, FileUp, Lock, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { SubNav } from '@/components/sub-nav';
import type { ActionResult } from '@/lib/api';
import { photoUrl } from '@/lib/photo';
import type { FullProfile, PostalAddressView, ProfileSectionKey } from '@/lib/types';
import { cancelProfileUpdateAction, editProfileSectionAction, submitProfileUpdateAction, uploadProfileDocumentAction } from './actions';

type Tab = 'personal' | 'professional' | 'address' | 'emergency' | 'education' | 'employment' | 'skills' | 'bank' | 'identity';
const TABS: [Tab, string][] = [
  ['personal', 'Personal'], ['professional', 'Professional'], ['address', 'Address'], ['emergency', 'Emergency contacts'], ['education', 'Education'],
  ['employment', 'Previous employment'], ['skills', 'Skills & languages'], ['bank', 'Bank'], ['identity', 'Identity'],
];
const UPDATE_STATUS: Record<string, [string, Tone]> = {
  pending: ['Waiting for HR approval', 'warning'], info_requested: ['HR needs more information', 'danger'], rejected: ['Rejected by HR', 'danger'], approved: ['Approved', 'success'],
};
const label = (v: string | null | undefined) => (v ? v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : '—');
const day = (d: string | null | undefined) => (d ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(d.length === 10 ? `${d}T00:00:00Z` : d)) : '—');
const EMPTY_ADDRESS: PostalAddressView = { line1: '', line2: '', city: '', state: '', postalCode: '', country: 'India' };
const addressText = (a: PostalAddressView | null | undefined) => (a ? [a.line1, a.line2, a.city, a.state, a.postalCode, a.country].filter((x) => x?.trim()).join(', ') : '') || '—';

function Rows({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-4 px-5 pb-5 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs text-fg-subtle">{k}</dt>
          <dd className="mt-0.5 break-words text-sm font-medium">{v === null || v === undefined || v === '' ? '—' : v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Chips({ items }: { items: string[] }) {
  return items.length ? <div className="flex flex-wrap gap-1.5">{items.map((i) => <Badge key={i} tone="neutral">{i}</Badge>)}</div> : <span>—</span>;
}

/** A free list of words (skills, languages): type and press Enter. */
function ListInput({ value, onChange, label: l }: { value: string[]; onChange: (v: string[]) => void; label: string }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setDraft('');
  };
  return (
    <div className="grid gap-2">
      <div className="flex gap-2">
        <Input aria-label={`Add to ${l}`} value={draft} maxLength={80} placeholder="Type and press Enter" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <Button type="button" variant="secondary" onClick={add}>Add</Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {value.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 rounded-full bg-bg-subtle px-2.5 py-1 text-xs">
            {v}
            <button type="button" aria-label={`Remove ${v}`} className="text-fg-subtle hover:text-danger" onClick={() => onChange(value.filter((x) => x !== v))}>×</button>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Uploads a supporting file into the employee's documents and links it. */
function DocPicker({ employeeId, documentId, onChange, category, title }: { employeeId: string; documentId: string | null; onChange: (id: string | null) => void; category: string; title: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const upload = () => {
    const f = ref.current?.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.set('file', f);
    fd.set('category', category);
    fd.set('title', title);
    start(async () => {
      const r = await uploadProfileDocumentAction(employeeId, fd);
      if (r.ok && r.data) { onChange(r.data.id); setName(f.name); setError(null); } else if (!r.ok) setError(r.message);
      if (ref.current) ref.current.value = '';
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {documentId ? (
        <>
          <a className="inline-flex items-center gap-1 font-medium text-accent hover:underline" href={`/files/${documentId}`}><Download className="size-4" aria-hidden />{name ?? 'Attached file'}</a>
          <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>Remove</Button>
        </>
      ) : (
        <label className={cn('inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-1.5 text-fg-muted hover:border-accent', pending && 'opacity-60')}>
          <FileUp className="size-4" aria-hidden />{pending ? 'Uploading…' : `Attach ${title.toLowerCase()}`}
          <input ref={ref} type="file" className="sr-only" accept=".pdf,.png,.jpg,.jpeg,.webp" onChange={upload} />
        </label>
      )}
      {error && <span role="alert" className="text-xs text-danger">{error}</span>}
    </div>
  );
}

export function ProfileView({ profile, tab: initialTab }: { profile: FullProfile; tab?: string }) {
  const router = useRouter();
  const p = profile;
  const s = p.sections;
  const tab: Tab = TABS.some(([k]) => k === initialTab) ? (initialTab as Tab) : 'personal';
  const [editing, setEditing] = useState<ProfileSectionKey | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string; fields?: Record<string, string> } | null>(null);
  const [pending, start] = useTransition();
  const canEdit = (section: ProfileSectionKey) => (p.can.submit || (p.can.editDirect && (!['bank', 'identity'].includes(section) || p.can.editSensitive)));
  const base = p.self ? '/profile' : `/profile/${p.employee.id}`;

  const save = (section: ProfileSectionKey, data: unknown, note?: string) => start(async () => {
    const r: ActionResult<unknown> = p.self ? await submitProfileUpdateAction(p.employee.id, section, data, note) : await editProfileSectionAction(p.employee.id, section, data);
    setNotice(r.ok ? { tone: 'success', text: r.message ?? 'Saved.' } : { tone: 'danger', text: r.message, fields: r.fieldErrors });
    if (r.ok) { setEditing(null); router.refresh(); }
  });

  const Update = ({ section }: { section: ProfileSectionKey }) => {
    const u = p.updates[section];
    if (!u || (u.status === 'approved' && Date.now() - Date.parse(u.decidedAt ?? u.createdAt) > 7 * 864e5)) return null;
    const [text, tone] = UPDATE_STATUS[u.status] ?? [u.status, 'neutral' as Tone];
    return (
      <div className="mx-5 mb-4 rounded-lg border border-border bg-bg-subtle p-3 text-sm" data-testid={`update-${section}`}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={tone} dot>{text}</Badge>
          <span className="text-xs text-fg-subtle">Sent {day(u.createdAt)}</span>
          {p.self && (u.status === 'pending' || u.status === 'info_requested') && (
            <Button size="sm" variant="ghost" className="ml-auto" loading={pending} onClick={() => start(async () => { const r = await cancelProfileUpdateAction(u.id); setNotice(r.ok ? { tone: 'success', text: r.message ?? '' } : { tone: 'danger', text: r.message }); router.refresh(); })}>Withdraw</Button>
          )}
          {p.can.review && u.status === 'pending' && <Link className="ml-auto text-xs font-medium text-accent hover:underline" href={`/profile/updates/${u.id}`}>Review</Link>}
        </div>
        {u.remarks && u.status !== 'approved' && <p className="mt-2 text-sm"><b>HR:</b> {u.remarks}</p>}
        {u.status === 'pending' && (
          <ul className="mt-2 grid gap-1 text-xs text-fg-muted">
            {u.changes.slice(0, 6).map((c) => <li key={c.field}><b className="text-fg">{c.label}:</b> {c.old ?? '—'} → {c.new ?? '—'}</li>)}
          </ul>
        )}
      </div>
    );
  };

  const header = (section: ProfileSectionKey, title: string, description?: string) => (
    <CardHeader
      title={title}
      description={description ?? (p.self ? 'Changes go to HR for approval before they replace what is on record.' : undefined)}
      action={canEdit(section) && editing !== section ? <Button size="sm" variant="secondary" onClick={() => { setNotice(null); setEditing(section); }}><Pencil className="size-3.5" />{p.self ? 'Update' : 'Edit'}</Button> : undefined}
    />
  );

  const src = photoUrl({ id: p.employee.id, photoUpdatedAt: p.employee.photoUpdatedAt });
  return (
    <div className="grid gap-6">
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-5 bg-gradient-to-br from-accent/10 via-transparent to-transparent p-6">
          {src ? <img src={src} alt="" className="size-20 rounded-2xl object-cover" /> : <div className="grid size-20 place-items-center rounded-2xl bg-accent text-2xl font-semibold text-accent-fg" aria-hidden>{p.employee.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}</div>}
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-semibold">{p.employee.name}</h2>
            <p className="text-sm text-fg-muted">{[p.professional.designation, p.professional.department, p.employee.code].filter(Boolean).join(' · ')}</p>
            {!p.self && <Link className="mt-1 inline-block text-sm font-medium text-accent hover:underline" href={`/employees/${p.employee.id}`}>Employee record, documents and job history</Link>}
          </div>
          <div className="grid w-full max-w-xs gap-1.5 sm:w-64">
            <div className="flex justify-between text-sm"><span className="text-fg-muted">Profile complete</span><span className="font-semibold tabular" data-testid="profile-completeness">{p.completeness}%</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-bg-subtle" role="progressbar" aria-valuenow={p.completeness} aria-valuemin={0} aria-valuemax={100} aria-label="Profile complete">
              <div className="h-full rounded-full bg-accent transition-[width] duration-700 motion-reduce:transition-none" style={{ width: `${p.completeness}%` }} />
            </div>
            <p className="text-xs text-fg-subtle">{(Object.entries(p.filled) as [ProfileSectionKey, boolean][]).filter(([, v]) => !v).map(([k]) => PROFILE_SECTION_LABELS[k]).join(', ') || 'Every section has details.'}{Object.values(p.filled).some((v) => !v) ? ' still to fill in.' : ''}</p>
          </div>
        </div>
      </Card>

      <SubNav label="Profile sections" items={TABS.map(([k, l]) => ({ href: `${base}?tab=${k}`, label: l, alert: k !== 'professional' && (p.updates[k as ProfileSectionKey]?.status === 'info_requested' || p.updates[k as ProfileSectionKey]?.status === 'rejected') }))} current={`${base}?tab=${tab}`} />
      {notice && (
        <Alert tone={notice.tone}>
          {notice.text}
          {notice.fields && <ul className="mt-1 list-disc pl-5 text-xs">{Object.entries(notice.fields).slice(0, 8).map(([k, v]) => <li key={k}>{k}: {v}</li>)}</ul>}
        </Alert>
      )}

      {tab === 'personal' && (
        <Card>
          {header('personal', 'Personal details')}
          <Update section="personal" />
          {editing === 'personal' ? <PersonalForm value={s.personal} pending={pending} self={p.self} onCancel={() => setEditing(null)} onSave={(d, n) => save('personal', d, n)} /> : (
            <Rows rows={[
              ['Full name', `${s.personal.firstName} ${s.personal.lastName}`.trim()], ['Preferred name', s.personal.preferredName], ['Date of birth', day(s.personal.dateOfBirth)],
              ['Gender', label(s.personal.gender)], ['Personal phone', s.personal.phone], ['Personal email', s.personal.personalEmail], ['Nationality', s.personal.nationality],
              ['Marital status', label(s.personal.maritalStatus)], ['Blood group', s.personal.bloodGroup],
            ]} />
          )}
        </Card>
      )}

      {tab === 'professional' && (
        <Card>
          <CardHeader title="Professional details" description="Set by HR. Ask HR if anything here is wrong." action={<Badge tone="neutral"><Lock className="size-3" aria-hidden /> HR managed</Badge>} />
          <Rows rows={[
            ['Employee ID', p.professional.employeeCode], ['Designation', p.professional.designation], ['Department', p.professional.department],
            ['Workspace access', p.professional.workspaceAccess ?? 'None (no login)'], ['Assigned workspace', p.professional.assignedWorkspace ?? 'Central group'], ['Reporting manager', p.professional.manager],
            ['Employment type', label(p.professional.employmentType)], ['Status', label(p.professional.status)], ['Date of joining', day(p.professional.dateOfJoining)],
            ['Confirmation date', day(p.professional.confirmationDate ?? p.professional.probationEndDate)], ['Work email', p.professional.workEmail], ['Grade', p.professional.grade],
            ['Office location', p.professional.location ? <>{p.professional.location.name}{p.professional.location.address && <div className="text-xs font-normal text-fg-muted">{p.professional.location.address}</div>}</> : null],
            ['Company', p.professional.company ? <>{p.professional.company.name}{p.professional.company.address && <div className="text-xs font-normal text-fg-muted">{p.professional.company.address}</div>}</> : null],
            ['Shift', p.professional.shift ? `${p.professional.shift.name} (${p.professional.shift.start} to ${p.professional.shift.end})` : 'Standard hours'],
            ['Working days', p.professional.workingDays.join(', ')],
          ]} />
        </Card>
      )}

      {tab === 'address' && (
        <Card>
          {header('address', 'Address')}
          <Update section="address" />
          {editing === 'address' ? <AddressForm value={s.address} pending={pending} self={p.self} onCancel={() => setEditing(null)} onSave={(d, n) => save('address', d, n)} /> : (
            <Rows rows={[['Current address', addressText(s.address?.current)], ['Permanent address', s.address?.permanentSameAsCurrent ? (s.address?.current ? 'Same as current address' : '—') : addressText(s.address?.permanent)]]} />
          )}
        </Card>
      )}

      {tab === 'emergency' && (
        <Card>
          {header('emergency', 'Emergency contacts', 'Who to call if something happens at work. Up to three people.')}
          <Update section="emergency" />
          {editing === 'emergency' ? <EmergencyForm value={s.emergency} pending={pending} self={p.self} onCancel={() => setEditing(null)} onSave={(d, n) => save('emergency', d, n)} /> : (
            s.emergency?.contacts.length ? (
              <ul className="grid gap-3 px-5 pb-5 sm:grid-cols-2 lg:grid-cols-3">
                {s.emergency.contacts.map((c, i) => (
                  <li key={i} className="rounded-lg border border-border p-3 text-sm"><div className="font-medium">{c.name}</div><div className="text-fg-muted">{c.relationship}</div><div className="mt-1 tabular">{c.phone}</div>{c.email && <div className="text-fg-muted">{c.email}</div>}</li>
                ))}
              </ul>
            ) : <p className="px-5 pb-5 text-sm text-fg-muted">No emergency contact yet.</p>
          )}
        </Card>
      )}

      {tab === 'education' && (
        <Card>
          {header('education', 'Education')}
          <Update section="education" />
          {editing === 'education' ? <EducationForm employeeId={p.employee.id} value={s.education} pending={pending} self={p.self} onCancel={() => setEditing(null)} onSave={(d, n) => save('education', d, n)} /> : (
            <div className="grid gap-3 px-5 pb-5">
              <div className="text-sm"><span className="text-fg-subtle">Highest qualification: </span><b>{s.education?.highestQualification ?? '—'}</b></div>
              {s.education?.records.length ? (
                <ul className="grid gap-2">
                  {s.education.records.map((r, i) => (
                    <li key={i} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm">
                      <div><div className="font-medium">{EDUCATION_LEVEL_LABELS[r.level as keyof typeof EDUCATION_LEVEL_LABELS] ?? r.level}{r.degree ? `: ${r.degree}` : ''}</div><div className="text-fg-muted">{r.institution}{r.yearCompleted ? `, ${r.yearCompleted}` : ''}</div></div>
                      <div className="flex items-center gap-3">{r.percentage !== null && <Badge tone="accent">{r.percentage}%</Badge>}{r.documentId && <a className="text-xs font-medium text-accent hover:underline" href={`/files/${r.documentId}`}>Certificate</a>}</div>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-sm text-fg-muted">No education records yet.</p>}
            </div>
          )}
        </Card>
      )}

      {tab === 'employment' && (
        <Card>
          {header('employment', 'Previous employment')}
          <Update section="employment" />
          {editing === 'employment' ? <EmploymentForm employeeId={p.employee.id} value={s.employment} pending={pending} self={p.self} onCancel={() => setEditing(null)} onSave={(d, n) => save('employment', d, n)} /> : (
            <div className="grid gap-3 px-5 pb-5">
              <div className="text-sm"><span className="text-fg-subtle">Total work experience before joining: </span><b>{s.employment?.totalExperienceMonths !== null && s.employment?.totalExperienceMonths !== undefined ? `${Math.floor(s.employment.totalExperienceMonths / 12)} years ${s.employment.totalExperienceMonths % 12} months` : '—'}</b></div>
              {s.employment?.records.length ? (
                <ol className="grid gap-2">
                  {s.employment.records.map((r, i) => (
                    <li key={i} className="rounded-lg border border-border p-3 text-sm">
                      <div className="font-medium">{r.company}{r.designation ? `, ${r.designation}` : ''}</div>
                      <div className="text-fg-muted">{day(r.from)} to {r.to ? day(r.to) : 'present'}{r.reasonForLeaving ? ` · ${r.reasonForLeaving}` : ''}</div>
                      {r.documentId && <a className="text-xs font-medium text-accent hover:underline" href={`/files/${r.documentId}`}>Relieving letter / document</a>}
                    </li>
                  ))}
                </ol>
              ) : <p className="text-sm text-fg-muted">No previous employment recorded.</p>}
            </div>
          )}
        </Card>
      )}

      {tab === 'skills' && (
        <Card>
          {header('skills', 'Skills & languages')}
          <Update section="skills" />
          {editing === 'skills' ? <SkillsForm value={s.skills} pending={pending} self={p.self} onCancel={() => setEditing(null)} onSave={(d, n) => save('skills', d, n)} /> : (
            <Rows rows={[['Skills', <Chips key="s" items={s.skills?.skills ?? []} />], ['Languages', <Chips key="l" items={s.skills?.languages ?? []} />], ['Certifications', <Chips key="c" items={s.skills?.certifications ?? []} />]]} />
          )}
        </Card>
      )}

      {tab === 'bank' && (
        <Card>
          {header('bank', 'Bank details', 'Used for salary payments. Only you, HR and Finance can see it; numbers are encrypted and shown masked.')}
          <Update section="bank" />
          {s.bank && 'hidden' in s.bank && s.bank.hidden ? <SensitiveHidden /> : editing === 'bank' ? <BankForm pending={pending} self={p.self} current={s.bank && !('hidden' in s.bank && s.bank.hidden) ? s.bank : null} onCancel={() => setEditing(null)} onSave={(d, n) => save('bank', d, n)} /> : (
            s.bank && !s.bank.hidden ? (
              <Rows rows={[['Account holder', s.bank.accountHolderName], ['Bank', s.bank.bankName], ['Branch', s.bank.branchName], ['Account number', <span key="a" className="tabular">{s.bank.accountNumber}</span>], ['IFSC', s.bank.ifsc], ['Account type', label(s.bank.accountType)]]} />
            ) : <p className="px-5 pb-5 text-sm text-fg-muted">No bank details yet.</p>
          )}
        </Card>
      )}

      {tab === 'identity' && (
        <Card>
          {header('identity', 'Identity numbers', 'Aadhaar, PAN and other government IDs, with proof. Numbers are encrypted and shown masked.')}
          <Update section="identity" />
          {s.identity && 'hidden' in s.identity && s.identity.hidden ? <SensitiveHidden /> : editing === 'identity' ? <IdentityForm employeeId={p.employee.id} pending={pending} self={p.self} current={s.identity && !s.identity.hidden ? s.identity : null} onCancel={() => setEditing(null)} onSave={(d, n) => save('identity', d, n)} /> : (
            s.identity && !s.identity.hidden ? (
              <Rows rows={[
                ['Aadhaar', <span key="a" className="tabular">{s.identity.aadhaar ?? '—'}</span>], ['PAN', <span key="p" className="tabular">{s.identity.pan ?? '—'}</span>],
                ['Other ID', s.identity.otherIdType ? `${s.identity.otherIdType}: ${s.identity.otherIdNumber ?? ''}` : null],
                ['Identity proof', s.identity.identityDocumentId ? <a key="i" className="text-accent hover:underline" href={`/files/${s.identity.identityDocumentId}`}>Open file</a> : null],
                ['Address proof', s.identity.addressProofDocumentId ? <a key="d" className="text-accent hover:underline" href={`/files/${s.identity.addressProofDocumentId}`}>Open file</a> : null],
              ]} />
            ) : <p className="px-5 pb-5 text-sm text-fg-muted">No identity details yet.</p>
          )}
        </Card>
      )}
    </div>
  );
}

function SensitiveHidden() {
  return <p className="flex items-center gap-2 px-5 pb-5 text-sm text-fg-muted"><ShieldCheck className="size-4 text-accent" aria-hidden />Recorded. Only the employee, HR and Finance can see these details.</p>;
}

type FormProps<T> = { value: T; pending: boolean; self: boolean; onCancel: () => void; onSave: (data: unknown, note?: string) => void };

function FormFooter({ pending, self, onCancel, onSave, note, setNote, disabled }: { pending: boolean; self: boolean; onCancel: () => void; onSave: () => void; note: string; setNote: (v: string) => void; disabled?: boolean }) {
  return (
    <div className="grid gap-3 border-t border-border pt-4 md:col-span-full">
      {self && <Field label="Note for HR (optional)">{(fp) => <Input {...fp} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />}</Field>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button loading={pending} disabled={disabled} onClick={onSave}>{self ? 'Send to HR for approval' : 'Save'}</Button>
      </div>
    </div>
  );
}

function PersonalForm({ value, pending, self, onCancel, onSave }: FormProps<FullProfile['sections']['personal']>) {
  const [v, setV] = useState(value);
  const [note, setNote] = useState('');
  const set = (patch: Partial<typeof v>) => setV({ ...v, ...patch });
  return (
    <div className="grid gap-4 px-5 pb-5 md:grid-cols-3">
      <Field label="First name" required>{(fp) => <Input {...fp} value={v.firstName} maxLength={80} onChange={(e) => set({ firstName: e.target.value })} />}</Field>
      <Field label="Last name">{(fp) => <Input {...fp} value={v.lastName} maxLength={80} onChange={(e) => set({ lastName: e.target.value })} />}</Field>
      <Field label="Preferred name">{(fp) => <Input {...fp} value={v.preferredName ?? ''} maxLength={80} onChange={(e) => set({ preferredName: e.target.value || null })} />}</Field>
      <Field label="Date of birth">{(fp) => <DatePicker {...fp} value={v.dateOfBirth ?? ''} max={new Date().toISOString().slice(0, 10)} openTo="1995-01-01" onChange={(x) => set({ dateOfBirth: x || null })} calendarLabel="Choose date of birth" />}</Field>
      <Field label="Gender">{(fp) => <Select {...fp} value={v.gender ?? ''} onChange={(e) => set({ gender: e.target.value || null })}><option value="">Not given</option><option value="female">Female</option><option value="male">Male</option><option value="non_binary">Non-binary</option><option value="undisclosed">Prefer not to say</option></Select>}</Field>
      <Field label="Personal phone">{(fp) => <Input {...fp} type="tel" value={v.phone ?? ''} maxLength={40} placeholder="+91 98200 12345" onChange={(e) => set({ phone: e.target.value || null })} />}</Field>
      <Field label="Personal email">{(fp) => <Input {...fp} type="email" value={v.personalEmail ?? ''} maxLength={254} onChange={(e) => set({ personalEmail: e.target.value || null })} />}</Field>
      <Field label="Nationality">{(fp) => <Input {...fp} value={v.nationality ?? ''} maxLength={60} onChange={(e) => set({ nationality: e.target.value || null })} />}</Field>
      <Field label="Marital status">{(fp) => <Select {...fp} value={v.maritalStatus ?? ''} onChange={(e) => set({ maritalStatus: e.target.value || null })}><option value="">Not given</option>{MARITAL_STATUSES.map((m) => <option key={m} value={m}>{label(m)}</option>)}</Select>}</Field>
      <Field label="Blood group">{(fp) => <Select {...fp} value={v.bloodGroup ?? ''} onChange={(e) => set({ bloodGroup: e.target.value || null })}><option value="">Not given</option>{BLOOD_GROUPS.map((b) => <option key={b} value={b}>{b}</option>)}</Select>}</Field>
      <FormFooter pending={pending} self={self} onCancel={onCancel} note={note} setNote={setNote} onSave={() => onSave(v, note)} />
    </div>
  );
}

function AddressFields({ value, onChange, legend }: { value: PostalAddressView; onChange: (v: PostalAddressView) => void; legend: string }) {
  const set = (patch: Partial<PostalAddressView>) => onChange({ ...value, ...patch });
  return (
    <fieldset className="grid gap-3 md:col-span-full md:grid-cols-3">
      <legend className="mb-1 text-sm font-semibold">{legend}</legend>
      <Field className="md:col-span-2" label="Address line 1">{(fp) => <Input {...fp} value={value.line1} maxLength={200} onChange={(e) => set({ line1: e.target.value })} />}</Field>
      <Field label="Address line 2">{(fp) => <Input {...fp} value={value.line2} maxLength={200} onChange={(e) => set({ line2: e.target.value })} />}</Field>
      <Field label="City">{(fp) => <Input {...fp} value={value.city} maxLength={80} onChange={(e) => set({ city: e.target.value })} />}</Field>
      <Field label="State">{(fp) => <Input {...fp} value={value.state} maxLength={80} onChange={(e) => set({ state: e.target.value })} />}</Field>
      <Field label="PIN / postal code">{(fp) => <Input {...fp} value={value.postalCode} maxLength={12} onChange={(e) => set({ postalCode: e.target.value })} />}</Field>
      <Field label="Country">{(fp) => <Input {...fp} value={value.country} maxLength={60} onChange={(e) => set({ country: e.target.value })} />}</Field>
    </fieldset>
  );
}

function AddressForm({ value, pending, self, onCancel, onSave }: FormProps<FullProfile['sections']['address']>) {
  const [current, setCurrent] = useState(value?.current ?? EMPTY_ADDRESS);
  const [same, setSame] = useState(value?.permanentSameAsCurrent ?? true);
  const [permanent, setPermanent] = useState(value?.permanent ?? EMPTY_ADDRESS);
  const [note, setNote] = useState('');
  return (
    <div className="grid gap-4 px-5 pb-5 md:grid-cols-3">
      <AddressFields legend="Current residential address" value={current} onChange={setCurrent} />
      <Checkbox className="md:col-span-full" label="My permanent address is the same" checked={same} onChange={(e) => setSame(e.target.checked)} />
      {!same && <AddressFields legend="Permanent address" value={permanent} onChange={setPermanent} />}
      <FormFooter pending={pending} self={self} onCancel={onCancel} note={note} setNote={setNote} onSave={() => onSave({ current, permanentSameAsCurrent: same, permanent: same ? null : permanent }, note)} />
    </div>
  );
}

function EmergencyForm({ value, pending, self, onCancel, onSave }: FormProps<FullProfile['sections']['emergency']>) {
  const [list, setList] = useState(value?.contacts.length ? value.contacts : [{ name: '', relationship: '', phone: '', email: null as string | null }]);
  const [note, setNote] = useState('');
  const set = (i: number, patch: Partial<(typeof list)[number]>) => setList(list.map((c, k) => (k === i ? { ...c, ...patch } : c)));
  return (
    <div className="grid gap-4 px-5 pb-5">
      {list.map((c, i) => (
        <fieldset key={i} className="grid gap-3 rounded-lg border border-border p-3 md:grid-cols-[repeat(4,minmax(0,1fr))_auto] md:items-end">
          <legend className="px-1 text-xs font-semibold text-fg-muted">Contact {i + 1}</legend>
          <Field label="Name" required>{(fp) => <Input {...fp} value={c.name} maxLength={120} onChange={(e) => set(i, { name: e.target.value })} />}</Field>
          <Field label="Relationship" required>{(fp) => <Input {...fp} value={c.relationship} maxLength={60} placeholder="Spouse, parent…" onChange={(e) => set(i, { relationship: e.target.value })} />}</Field>
          <Field label="Phone" required>{(fp) => <Input {...fp} type="tel" value={c.phone} maxLength={40} onChange={(e) => set(i, { phone: e.target.value })} />}</Field>
          <Field label="Email">{(fp) => <Input {...fp} type="email" value={c.email ?? ''} maxLength={254} onChange={(e) => set(i, { email: e.target.value || null })} />}</Field>
          <Button variant="ghost" size="sm" aria-label={`Remove contact ${i + 1}`} onClick={() => setList(list.filter((_, k) => k !== i))}><Trash2 className="size-4" /></Button>
        </fieldset>
      ))}
      {list.length < 3 && <div><Button size="sm" variant="secondary" onClick={() => setList([...list, { name: '', relationship: '', phone: '', email: null }])}><Plus className="size-4" />Add contact</Button></div>}
      <FormFooter pending={pending} self={self} onCancel={onCancel} note={note} setNote={setNote} onSave={() => onSave({ contacts: list }, note)} />
    </div>
  );
}

function EducationForm({ employeeId, value, pending, self, onCancel, onSave }: FormProps<FullProfile['sections']['education']> & { employeeId: string }) {
  type R = NonNullable<FullProfile['sections']['education']>['records'][number];
  const blank: R = { level: 'graduation', degree: null, institution: '', yearCompleted: null, percentage: null, documentId: null };
  const [highest, setHighest] = useState(value?.highestQualification ?? '');
  const [records, setRecords] = useState<R[]>(value?.records.length ? value.records : [blank]);
  const [note, setNote] = useState('');
  const set = (i: number, patch: Partial<R>) => setRecords(records.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const num = (v: string) => (v === '' ? null : Number(v));
  return (
    <div className="grid gap-4 px-5 pb-5">
      <Field label="Highest qualification">{(fp) => <Input {...fp} value={highest} maxLength={120} placeholder="For example B.Tech in Mechanical Engineering" onChange={(e) => setHighest(e.target.value)} />}</Field>
      {records.map((r, i) => (
        <fieldset key={i} className="grid gap-3 rounded-lg border border-border p-3 md:grid-cols-6">
          <legend className="px-1 text-xs font-semibold text-fg-muted">Record {i + 1}</legend>
          <Field label="Level">{(fp) => <Select {...fp} value={r.level} onChange={(e) => set(i, { level: e.target.value })}>{EDUCATION_LEVELS.map((l) => <option key={l} value={l}>{EDUCATION_LEVEL_LABELS[l]}</option>)}</Select>}</Field>
          <Field label="Degree / course">{(fp) => <Input {...fp} value={r.degree ?? ''} maxLength={120} onChange={(e) => set(i, { degree: e.target.value || null })} />}</Field>
          <Field className="md:col-span-2" label="School / university" required>{(fp) => <Input {...fp} value={r.institution} maxLength={160} onChange={(e) => set(i, { institution: e.target.value })} />}</Field>
          <Field label="Year">{(fp) => <Input {...fp} type="number" min={1950} max={2100} value={r.yearCompleted ?? ''} onChange={(e) => set(i, { yearCompleted: num(e.target.value) })} />}</Field>
          <Field label="Percentage">{(fp) => <Input {...fp} type="number" min={0} max={100} step={0.01} value={r.percentage ?? ''} onChange={(e) => set(i, { percentage: num(e.target.value) })} />}</Field>
          <div className="flex items-center justify-between gap-2 md:col-span-6">
            <DocPicker employeeId={employeeId} documentId={r.documentId} onChange={(id) => set(i, { documentId: id })} category="certificate" title="Certificate" />
            <Button variant="ghost" size="sm" aria-label={`Remove record ${i + 1}`} onClick={() => setRecords(records.filter((_, k) => k !== i))}><Trash2 className="size-4" /></Button>
          </div>
        </fieldset>
      ))}
      <div><Button size="sm" variant="secondary" onClick={() => setRecords([...records, blank])}><Plus className="size-4" />Add education</Button></div>
      <FormFooter pending={pending} self={self} onCancel={onCancel} note={note} setNote={setNote} onSave={() => onSave({ highestQualification: highest || null, records }, note)} />
    </div>
  );
}

function EmploymentForm({ employeeId, value, pending, self, onCancel, onSave }: FormProps<FullProfile['sections']['employment']> & { employeeId: string }) {
  type R = NonNullable<FullProfile['sections']['employment']>['records'][number];
  const blank: R = { company: '', designation: null, from: '', to: null, lastSalary: null, reasonForLeaving: null, documentId: null };
  const [months, setMonths] = useState(value?.totalExperienceMonths ?? null);
  const [records, setRecords] = useState<R[]>(value?.records ?? []);
  const [note, setNote] = useState('');
  const set = (i: number, patch: Partial<R>) => setRecords(records.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <div className="grid gap-4 px-5 pb-5">
      <div className="grid grid-cols-2 gap-3 sm:w-80">
        <Field label="Experience: years">{(fp) => <Input {...fp} type="number" min={0} max={60} value={months === null ? '' : Math.floor(months / 12)} onChange={(e) => setMonths(e.target.value === '' ? null : Number(e.target.value) * 12 + ((months ?? 0) % 12))} />}</Field>
        <Field label="months">{(fp) => <Input {...fp} type="number" min={0} max={11} value={months === null ? '' : months % 12} onChange={(e) => setMonths(Math.floor((months ?? 0) / 12) * 12 + Number(e.target.value || 0))} />}</Field>
      </div>
      {records.map((r, i) => (
        <fieldset key={i} className="grid gap-3 rounded-lg border border-border p-3 md:grid-cols-4">
          <legend className="px-1 text-xs font-semibold text-fg-muted">Employer {i + 1}</legend>
          <Field label="Company" required>{(fp) => <Input {...fp} value={r.company} maxLength={160} onChange={(e) => set(i, { company: e.target.value })} />}</Field>
          <Field label="Designation">{(fp) => <Input {...fp} value={r.designation ?? ''} maxLength={120} onChange={(e) => set(i, { designation: e.target.value || null })} />}</Field>
          <Field label="From" required>{(fp) => <DatePicker {...fp} value={r.from} onChange={(x) => set(i, { from: x })} calendarLabel="Choose the start date" />}</Field>
          <Field label="To">{(fp) => <DatePicker {...fp} value={r.to ?? ''} min={r.from || undefined} onChange={(x) => set(i, { to: x || null })} calendarLabel="Choose the end date" />}</Field>
          <Field label="Last salary (yearly, optional)">{(fp) => <Input {...fp} type="number" min={0} value={r.lastSalary ?? ''} onChange={(e) => set(i, { lastSalary: e.target.value === '' ? null : Number(e.target.value) })} />}</Field>
          <Field className="md:col-span-2" label="Reason for leaving">{(fp) => <Input {...fp} value={r.reasonForLeaving ?? ''} maxLength={300} onChange={(e) => set(i, { reasonForLeaving: e.target.value || null })} />}</Field>
          <div className="flex items-end justify-between gap-2">
            <DocPicker employeeId={employeeId} documentId={r.documentId} onChange={(id) => set(i, { documentId: id })} category="other" title="Relieving letter" />
            <Button variant="ghost" size="sm" aria-label={`Remove employer ${i + 1}`} onClick={() => setRecords(records.filter((_, k) => k !== i))}><Trash2 className="size-4" /></Button>
          </div>
        </fieldset>
      ))}
      <div><Button size="sm" variant="secondary" onClick={() => setRecords([...records, blank])}><Plus className="size-4" />Add employer</Button></div>
      <FormFooter pending={pending} self={self} onCancel={onCancel} note={note} setNote={setNote} onSave={() => onSave({ totalExperienceMonths: months, records }, note)} />
    </div>
  );
}

function SkillsForm({ value, pending, self, onCancel, onSave }: FormProps<FullProfile['sections']['skills']>) {
  const [skills, setSkills] = useState(value?.skills ?? []);
  const [languages, setLanguages] = useState(value?.languages ?? []);
  const [certifications, setCertifications] = useState(value?.certifications ?? []);
  const [note, setNote] = useState('');
  return (
    <div className="grid gap-4 px-5 pb-5 md:grid-cols-3">
      <div className="grid gap-1.5"><span className="text-sm font-medium">Skills</span><ListInput label="skills" value={skills} onChange={setSkills} /></div>
      <div className="grid gap-1.5"><span className="text-sm font-medium">Languages</span><ListInput label="languages" value={languages} onChange={setLanguages} /></div>
      <div className="grid gap-1.5"><span className="text-sm font-medium">Professional certifications</span><ListInput label="certifications" value={certifications} onChange={setCertifications} /></div>
      <FormFooter pending={pending} self={self} onCancel={onCancel} note={note} setNote={setNote} onSave={() => onSave({ skills, languages, certifications }, note)} />
    </div>
  );
}

function BankForm({ current, pending, self, onCancel, onSave }: { current: { accountHolderName: string | null; bankName: string | null; branchName: string | null; accountType: string | null } | null; pending: boolean; self: boolean; onCancel: () => void; onSave: (d: unknown, note?: string) => void }) {
  const [v, setV] = useState({ accountHolderName: current?.accountHolderName ?? '', bankName: current?.bankName ?? '', accountNumber: '', ifsc: '', branchName: current?.branchName ?? '', accountType: current?.accountType ?? 'savings' });
  const [confirm, setConfirm] = useState('');
  const [note, setNote] = useState('');
  const set = (patch: Partial<typeof v>) => setV({ ...v, ...patch });
  const mismatch = confirm.length > 0 && confirm !== v.accountNumber;
  return (
    <div className="grid gap-4 px-5 pb-5 md:grid-cols-3">
      <Alert tone="info" className="md:col-span-full">Enter the full account number again, even if only the branch changed. It is encrypted as soon as it reaches SampCrew.</Alert>
      <Field label="Account holder name" required>{(fp) => <Input {...fp} value={v.accountHolderName} maxLength={120} onChange={(e) => set({ accountHolderName: e.target.value })} />}</Field>
      <Field label="Bank name" required>{(fp) => <Input {...fp} value={v.bankName} maxLength={120} onChange={(e) => set({ bankName: e.target.value })} />}</Field>
      <Field label="Branch">{(fp) => <Input {...fp} value={v.branchName} maxLength={120} onChange={(e) => set({ branchName: e.target.value })} />}</Field>
      <Field label="Account number" required>{(fp) => <Input {...fp} inputMode="numeric" autoComplete="off" value={v.accountNumber} maxLength={34} onChange={(e) => set({ accountNumber: e.target.value.replace(/\s/g, '') })} />}</Field>
      <Field label="Account number again" required error={mismatch ? 'The numbers do not match' : undefined}>{(fp) => <Input {...fp} inputMode="numeric" autoComplete="off" value={confirm} maxLength={34} onChange={(e) => setConfirm(e.target.value.replace(/\s/g, ''))} />}</Field>
      <Field label="IFSC" required>{(fp) => <Input {...fp} value={v.ifsc} maxLength={15} placeholder="SBIN0001234" onChange={(e) => set({ ifsc: e.target.value.toUpperCase() })} />}</Field>
      <Field label="Account type">{(fp) => <Select {...fp} value={v.accountType} onChange={(e) => set({ accountType: e.target.value })}>{ACCOUNT_TYPES.map((a) => <option key={a} value={a}>{a === 'nre' || a === 'nro' ? a.toUpperCase() : label(a)}</option>)}</Select>}</Field>
      <FormFooter pending={pending} disabled={mismatch || !v.accountNumber || confirm !== v.accountNumber} self={self} onCancel={onCancel} note={note} setNote={setNote} onSave={() => onSave({ ...v, branchName: v.branchName || null }, note)} />
    </div>
  );
}

function IdentityForm({ employeeId, current, pending, self, onCancel, onSave }: { employeeId: string; current: { otherIdType: string | null; identityDocumentId: string | null; addressProofDocumentId: string | null } | null; pending: boolean; self: boolean; onCancel: () => void; onSave: (d: unknown, note?: string) => void }) {
  const [v, setV] = useState({ aadhaar: '', pan: '', otherIdType: current?.otherIdType ?? '', otherIdNumber: '', identityDocumentId: current?.identityDocumentId ?? null, addressProofDocumentId: current?.addressProofDocumentId ?? null });
  const [note, setNote] = useState('');
  const set = (patch: Partial<typeof v>) => setV({ ...v, ...patch });
  return (
    <div className="grid gap-4 px-5 pb-5 md:grid-cols-2">
      <Alert tone="info" className="md:col-span-full">Enter every number you want on record. A box left empty clears that number.</Alert>
      <Field label="Aadhaar number" hint="12 digits">{(fp) => <Input {...fp} inputMode="numeric" autoComplete="off" value={v.aadhaar} maxLength={14} onChange={(e) => set({ aadhaar: e.target.value })} />}</Field>
      <Field label="PAN" hint="Like ABCDE1234F">{(fp) => <Input {...fp} autoComplete="off" value={v.pan} maxLength={10} onChange={(e) => set({ pan: e.target.value.toUpperCase() })} />}</Field>
      <Field label="Other government ID">{(fp) => <Input {...fp} value={v.otherIdType} maxLength={60} placeholder="Passport, voter ID, driving licence" onChange={(e) => set({ otherIdType: e.target.value })} />}</Field>
      <Field label="Its number">{(fp) => <Input {...fp} autoComplete="off" value={v.otherIdNumber} maxLength={40} onChange={(e) => set({ otherIdNumber: e.target.value })} />}</Field>
      <div className="grid gap-1.5"><span className="text-sm font-medium">Identity document</span><DocPicker employeeId={employeeId} documentId={v.identityDocumentId} onChange={(id) => set({ identityDocumentId: id })} category="id_proof" title="Identity proof" /></div>
      <div className="grid gap-1.5"><span className="text-sm font-medium">Address proof</span><DocPicker employeeId={employeeId} documentId={v.addressProofDocumentId} onChange={(id) => set({ addressProofDocumentId: id })} category="address_proof" title="Address proof" /></div>
      <FormFooter pending={pending} self={self} onCancel={onCancel} note={note} setNote={setNote} onSave={() => onSave({ aadhaar: v.aadhaar || null, pan: v.pan || null, otherIdType: v.otherIdType || null, otherIdNumber: v.otherIdNumber || null, identityDocumentId: v.identityDocumentId, addressProofDocumentId: v.addressProofDocumentId }, note)} />
    </div>
  );
}

