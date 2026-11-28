'use client';
import { REQUEST_MAX_APPROVERS, REQUEST_MAX_CC, type RequestPerson } from '@crew/contracts';
import { Avatar, Input, cn } from '@crew/ui';
import { Crown, Eye, Paperclip, Search, ShieldCheck, Upload, UserPlus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { searchPeopleAction, uploadRequestFileAction } from './actions';
import type { UploadedDoc } from './types';

export type Role = 'primary' | 'additional' | 'cc';
export interface Picked { primary: RequestPerson | null; additional: RequestPerson[]; cc: RequestPerson[] }

const ROLE_LABEL: Record<Role, string> = { primary: 'Primary approver', additional: 'Additional approver', cc: 'CC (told, does not approve)' };
const ROLE_STYLE: Record<string, string> = { manager: 'bg-info-subtle text-info', hr: 'bg-success-subtle text-success', super: 'bg-accent-subtle text-accent' };

/** Who the person is, in one line: level, designation, department, workspace. */
export const personLine = (p: RequestPerson) => [p.levelLabel, p.designation, p.department, p.workspace].filter(Boolean).join(' · ');

function roleOf(p: Picked, id: string): Role | null {
  if (p.primary?.membershipId === id) return 'primary';
  if (p.additional.some((x) => x.membershipId === id)) return 'additional';
  if (p.cc.some((x) => x.membershipId === id)) return 'cc';
  return null;
}

/** Puts a person in one role (a person is an approver or a CC participant, never both), or takes them off. */
export function assign(p: Picked, person: RequestPerson, role: Role | null): Picked {
  const id = person.membershipId;
  const next: Picked = { primary: p.primary?.membershipId === id ? null : p.primary, additional: p.additional.filter((x) => x.membershipId !== id), cc: p.cc.filter((x) => x.membershipId !== id) };
  if (role === 'primary') {
    // The previous primary approver stays on as an additional approver.
    if (next.primary && next.additional.length < REQUEST_MAX_APPROVERS - 1) next.additional = [next.primary, ...next.additional];
    next.primary = person;
  }
  if (role === 'additional' && next.additional.length < REQUEST_MAX_APPROVERS - 1) next.additional = [...next.additional, person];
  if (role === 'cc' && next.cc.length < REQUEST_MAX_CC) next.cc = [...next.cc, person];
  return next;
}

function RoleButtons({ value, onPick, name }: { value: Role | null; onPick: (r: Role | null) => void; name: string }) {
  const btn = (r: Role, icon: React.ReactNode, label: string) => (
    <button type="button" onClick={() => onPick(value === r ? null : r)} aria-pressed={value === r} title={ROLE_LABEL[r]} aria-label={`${ROLE_LABEL[r]}: ${name}`}
      className={cn('inline-flex items-center gap-1 rounded-md px-2 py-1 text-[0.6875rem] font-semibold transition-colors',
        value === r ? (r === 'cc' ? 'bg-fg text-bg' : 'bg-accent text-accent-fg') : 'bg-bg-subtle text-fg-muted hover:bg-border hover:text-fg')}>
      {icon}{label}
    </button>
  );
  return (
    <span className="flex shrink-0 flex-wrap justify-end gap-1">
      {btn('primary', <Crown className="size-3" />, 'Primary')}
      {btn('additional', <ShieldCheck className="size-3" />, 'Approver')}
      {btn('cc', <Eye className="size-3" />, 'CC')}
    </span>
  );
}

function PersonRow({ p, role, onPick }: { p: RequestPerson; role: Role | null; onPick: (r: Role | null) => void }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2.5 rounded-xl border p-2.5', role ? 'border-accent/50 bg-accent-subtle/60' : 'border-border bg-surface')} data-testid={`person-${p.membershipId}`}>
      <Avatar name={p.name} size={34} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.8125rem] font-semibold text-fg">{p.name}{p.employeeCode ? <span className="ml-1.5 font-mono text-[0.6875rem] font-normal text-fg-subtle">{p.employeeCode}</span> : null}</span>
        <span className="block truncate text-[0.6875rem] text-fg-muted">{personLine(p)}</span>
        {p.roleLabel && <span className={cn('mt-1 inline-block rounded-full px-1.5 py-px text-[0.625rem] font-semibold', ROLE_STYLE[p.role ?? ''] ?? 'bg-bg-subtle text-fg-muted')}>{p.roleLabel}</span>}
      </span>
      <RoleButtons value={role} onPick={onPick} name={p.name} />
    </div>
  );
}

/**
 * Who the request goes to: a primary approver, additional approvers and CC participants (told, but do not decide).
 * The reporting manager and HR are filled in to start with; anyone in the directory can be added, searched by name,
 * designation, department or workspace.
 */
export function PeoplePicker({ suggested, value, onChange, error }: { suggested: RequestPerson[]; value: Picked; onChange: (p: Picked) => void; error?: string }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<RequestPerson[]>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setFound([]); return; }
    setSearching(true);
    const t = setTimeout(() => { void searchPeopleAction(term).then((r) => { setFound(r.ok ? r.data?.items ?? [] : []); setSearching(false); }); }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const pick = (p: RequestPerson) => (r: Role | null) => onChange(assign(value, p, r));
  const suggestedIds = new Set(suggested.map((p) => p.membershipId));
  return (
    <div className="grid gap-4">
      {suggested.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Suggested for you</h3>
          <div className="grid gap-2" data-testid="suggested-approvers">
            {suggested.map((p) => <PersonRow key={p.membershipId} p={p} role={roleOf(value, p.membershipId)} onPick={pick(p)} />)}
          </div>
        </div>
      )}
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Employee directory</h3>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input aria-label="Search the employee directory" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, designation, department or workspace" data-testid="people-search" />
        </div>
        {q.trim().length >= 2 && (
          <div className="mt-2 grid max-h-72 gap-1.5 overflow-y-auto rounded-xl border border-border bg-bg-subtle p-1.5" aria-label="People found" aria-busy={searching}>
            {found.filter((p) => !suggestedIds.has(p.membershipId)).map((p) => <PersonRow key={p.membershipId} p={p} role={roleOf(value, p.membershipId)} onPick={pick(p)} />)}
            {!searching && !found.length && <p className="p-3 text-center text-xs text-fg-muted">Nobody matches “{q.trim()}”.</p>}
          </div>
        )}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

/** The chosen people, by role, for the summary card. */
export function PickedSummary({ value, onChange }: { value: Picked; onChange: (p: Picked) => void }) {
  const row = (p: RequestPerson, role: Role) => (
    <li key={`${role}-${p.membershipId}`} className="flex items-center gap-2 rounded-lg bg-bg-subtle px-2 py-1.5">
      <Avatar name={p.name} size={24} />
      <span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold">{p.name}</span><span className="block truncate text-[0.6875rem] text-fg-muted">{ROLE_LABEL[role]} · {p.levelLabel}</span></span>
      <button type="button" onClick={() => onChange(assign(value, p, null))} className="rounded p-0.5 text-fg-subtle hover:bg-surface hover:text-fg" aria-label={`Remove ${p.name}`}><X className="size-3.5" /></button>
    </li>
  );
  const none = !value.primary && !value.additional.length;
  return (
    <div className="grid gap-2">
      <ul className="grid gap-1.5" data-testid="picked-approvers">
        {value.primary && row(value.primary, 'primary')}
        {value.additional.map((p) => row(p, 'additional'))}
      </ul>
      {none && <span className="inline-flex items-center gap-1 text-xs text-fg-subtle"><UserPlus className="size-3.5" /> Choose the primary approver</span>}
      {value.cc.length > 0 && <ul className="grid gap-1.5" data-testid="picked-cc">{value.cc.map((p) => row(p, 'cc'))}</ul>}
    </div>
  );
}

export const pickedBody = (p: Picked) => ({ primaryApproverId: p.primary?.membershipId, additionalApproverIds: p.additional.map((x) => x.membershipId), ccIds: p.cc.map((x) => x.membershipId) });

/** Supporting documents: uploaded one by one, then sent with the request by id. */
export function Attachments({ value, onChange, mode }: { value: UploadedDoc[]; onChange: (d: UploadedDoc[]) => void; mode: 'none' | 'optional' | 'required' }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (mode === 'none') return null;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => input.current?.click()} disabled={busy || value.length >= 5}
          className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-border-strong bg-surface px-3 py-2 text-[0.8125rem] font-medium text-fg hover:bg-bg-subtle disabled:opacity-60" data-testid="attach-document">
          <Upload className="size-4" /> {busy ? 'Uploading…' : 'Attach a document'}
        </button>
        <span className="text-xs text-fg-muted">{mode === 'required' ? 'Required for this type. ' : 'Optional. '}PDF, image or Office file, up to 10 MB, 5 files.</span>
      </div>
      <input ref={input} type="file" className="sr-only" aria-label="Supporting document" onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        setBusy(true); setError(null);
        const fd = new FormData();
        fd.set('file', f);
        const r = await uploadRequestFileAction(fd);
        setBusy(false);
        if (!r.ok) { setError(r.message); return; }
        onChange([...value, r.data!]);
      }} />
      {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
      {value.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2" data-testid="attached-documents">
          {value.map((d) => (
            <li key={d.id} className="inline-flex items-center gap-1.5 rounded-full bg-bg-subtle px-2.5 py-1 text-xs">
              <Paperclip className="size-3.5 text-fg-subtle" /> <span className="max-w-48 truncate">{d.name}</span>
              <button type="button" onClick={() => onChange(value.filter((x) => x.id !== d.id))} aria-label={`Remove ${d.name}`} className="rounded p-0.5 text-fg-subtle hover:text-fg"><X className="size-3" /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A numbered section of a form. */
export function Step({ n, title, hint, children }: { n: number; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`step-${n}`} className="rounded-2xl border border-border bg-surface p-4 shadow-card sm:p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent to-accent-hover text-xs font-bold text-accent-fg shadow-card" aria-hidden>{n}</span>
        <div className="min-w-0">
          <h2 id={`step-${n}`} className="text-[0.9375rem] font-semibold text-fg">{title}</h2>
          {hint && <p className="text-xs text-fg-muted">{hint}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

/** The requester's details, filled in from their record (read only). */
export function RequesterCard({ me, manager, hr }: { me: RequestPerson & { dateOfJoining?: string | null }; manager: RequestPerson | null; hr: RequestPerson | null }) {
  const items: [string, string | null][] = [
    ['Employee code', me.employeeCode], ['Name', me.name], ['Designation', me.designation], ['Department', me.department],
    ['Workspace', [me.levelLabel, me.workspace].filter(Boolean).join(', ')], ['Reporting manager', manager?.name ?? null], ['HR manager', hr?.name ?? null],
  ];
  return (
    <dl className="grid gap-x-4 gap-y-3 text-[0.8125rem] sm:grid-cols-2 lg:grid-cols-3" data-testid="requester-details">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0 rounded-lg bg-bg-subtle px-3 py-2">
          <dt className="text-[0.6875rem] text-fg-subtle">{k}</dt>
          <dd className="truncate font-medium text-fg">{v || '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
