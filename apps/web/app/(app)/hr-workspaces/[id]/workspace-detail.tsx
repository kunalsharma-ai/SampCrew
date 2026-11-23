'use client';
import { HR_WORKSPACE_KIND_LABEL, HR_WORKSPACE_KINDS, PLATFORM_LEVEL_LABEL, type ConfigVersionRow, type HierarchyMemberRow, type HrWorkspaceDetail, type TransferRow } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, Dialog, EmptyState, Field, Input, Select, Stat, Table, TBody, TD, Textarea, TH, THead, TR, cn } from '@crew/ui';
import { ArrowRightLeft, Layers, Search, ShieldCheck, UserPlus, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { assignToHrWorkspaceAction, setHrWorkspaceAdminsAction, setHrWorkspaceStatusAction, setMemberModulesAction, transferEmployeeAction, updateHrWorkspaceAction } from '../actions';
import { ModulePicker } from '../module-picker';
import { MODULE_NAME } from '../modules';

type Option = { id: string; name: string; email?: string };
type Flash = { tone: 'success' | 'danger'; text: string } | null;

const TABS = [
  { key: 'modules', label: 'Modules and details' },
  { key: 'people', label: 'People' },
  { key: 'admins', label: 'Admins' },
  { key: 'documents', label: 'Documents' },
  { key: 'history', label: 'History' },
];
const STATUS_TONE = { active: 'success', suspended: 'warning', archived: 'neutral' } as const;
const ACTION_LABEL: Record<string, string> = {
  created: 'Created', updated: 'Changed', admins_changed: 'Admins changed', status_changed: 'Status changed', modules_changed: 'Modules changed',
  recalculated: 'Checked against the company', delegation_policy: 'SAMPLEDGE delegation policy',
};
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function WorkspaceDetail(p: {
  w: HrWorkspaceDetail; tab: string; query: string;
  people: HierarchyMemberRow[] | null; history: ConfigVersionRow[] | null; transfers: TransferRow[] | null;
  members: Option[]; others: Option[]; central: HierarchyMemberRow[] | null;
  /** The Documents tab, rendered on the server (its own documents and the requests sent to it). */
  documents?: React.ReactNode;
}) {
  const router = useRouter();
  const { w } = p;
  const given = w.modules.filter((m) => !m.core && m.state === 'granted').length;
  const inactive = w.modules.filter((m) => m.stale);
  return (
    <div className="grid gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Status" value={<Badge tone={STATUS_TONE[w.status]} dot>{w.status[0]!.toUpperCase() + w.status.slice(1)}</Badge>} hint={`Version ${w.version}`} />
        <Stat label="People" value={w.usage.limit >= 0 ? `${w.usage.employees} of ${w.usage.limit}` : w.usage.employees} icon={<Users className="size-4" />} />
        <Stat label="Modules given" value={given} hint={`Core HR is always on`} icon={<Layers className="size-4" />} />
        <Stat label="Admins" value={w.admins.length} hint={w.admins.map((a) => a.name ?? a.email).join(', ') || 'None yet'} icon={<ShieldCheck className="size-4" />} />
      </div>
      {inactive.length > 0 && (
        <Alert tone="warning">
          {inactive.map((m) => m.name).join(', ')} {inactive.length === 1 ? 'is' : 'are'} no longer held by the company, so {inactive.length === 1 ? 'it does' : 'they do'} not work here now. {inactive.length === 1 ? 'It comes' : 'They come'} back if SAMPLEDGE gives {inactive.length === 1 ? 'it' : 'them'} back.
        </Alert>
      )}
      {w.status === 'suspended' && <Alert tone="warning">This HR Workspace is suspended. Its people keep their modules, but nobody can be added, moved or changed until it is reactivated.</Alert>}

      <div role="tablist" aria-label="HR Workspace" className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => (
          <button key={t.key} role="tab" type="button" aria-selected={p.tab === t.key} onClick={() => router.push(`/hr-workspaces/${w.id}?tab=${t.key}`)}
            className={cn('-mb-px border-b-2 px-3 py-2 text-sm', p.tab === t.key ? 'border-accent font-medium text-fg' : 'border-transparent text-fg-muted hover:text-fg')}>{t.label}</button>
        ))}
      </div>

      {p.tab === 'modules' && <ModulesTab w={w} />}
      {p.tab === 'people' && p.people && <PeopleTab w={w} rows={p.people} query={p.query} others={p.others} central={p.central} />}
      {p.tab === 'admins' && <AdminsTab w={w} members={p.members} />}
      {p.tab === 'documents' && p.documents}
      {p.tab === 'history' && <HistoryTab history={p.history ?? []} transfers={p.transfers ?? []} />}
    </div>
  );
}

function ModulesTab({ w }: { w: HrWorkspaceDetail }) {
  const router = useRouter();
  const start0 = useMemo(() => w.modules.filter((m) => !m.core && (m.state === 'granted' || m.stale)).map((m) => m.key).sort(), [w.modules]);
  const [features, setFeatures] = useState(start0);
  const [flash, setFlash] = useState<Flash>(null);
  const [pending, start] = useTransition();
  const dirty = JSON.stringify(features) !== JSON.stringify(start0);
  // Show what would be given: a module ticked here is "granted" in the picker.
  const modules = useMemo(() => w.modules.map((m) => (m.state === 'locked' || m.core ? m : { ...m, state: features.includes(m.key) ? 'granted' as const : 'available' as const })), [w.modules, features]);
  const save = () => start(async () => {
    const r = await updateHrWorkspaceAction(w.id, { features }, w.version);
    setFlash({ tone: r.ok ? 'success' : 'danger', text: r.ok ? (r.message ?? 'Saved') : r.message });
    if (r.ok) router.refresh();
  });
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader
          title="Modules for this HR Workspace"
          description={w.can.manage ? 'Tick the modules its admins and people may use. Only modules your company holds can be given; its admins then choose which of these each person gets.' : 'The modules the Super Workspace gave this HR Workspace. You choose which of these each of your people gets, under People.'}
          action={w.can.manage ? <Button onClick={save} disabled={!dirty} loading={pending}>Save modules</Button> : undefined}
        />
        <CardBody className="grid gap-4">
          {flash && <Alert tone={flash.tone}>{flash.text}</Alert>}
          <ModulePicker modules={modules} value={features} onChange={setFeatures} disabled={!w.can.manage} />
        </CardBody>
      </Card>
      {w.can.manage && <DetailsCard w={w} />}
    </div>
  );
}

function DetailsCard({ w }: { w: HrWorkspaceDetail }) {
  const router = useRouter();
  const [name, setName] = useState(w.name);
  const [code, setCode] = useState(w.code ?? '');
  const [kind, setKind] = useState<string>(w.kind);
  const [description, setDescription] = useState(w.description);
  const [limit, setLimit] = useState(w.maxEmployees >= 0 ? String(w.maxEmployees) : '');
  const [flash, setFlash] = useState<Flash>(null);
  const [pending, start] = useTransition();
  const [status, setStatus] = useState<'active' | 'suspended' | 'archived' | null>(null);
  const save = () => start(async () => {
    const patch: Record<string, unknown> = {};
    if (name.trim() !== w.name) patch.name = name.trim();
    if ((code.trim() || null) !== w.code) patch.code = code.trim() ? code.trim().toUpperCase() : null;
    if (kind !== w.kind) patch.kind = kind;
    if (description.trim() !== w.description) patch.description = description.trim();
    const max = limit.trim() ? Number(limit) : -1;
    if (max !== w.maxEmployees) patch.maxEmployees = max;
    if (!Object.keys(patch).length) { setFlash({ tone: 'success', text: 'Nothing changed.' }); return; }
    const r = await updateHrWorkspaceAction(w.id, patch, w.version);
    setFlash({ tone: r.ok ? 'success' : 'danger', text: r.ok ? (r.message ?? 'Saved') : r.message });
    if (r.ok) router.refresh();
  });
  return (
    <Card>
      <CardHeader title="Details and limits" description="Its name, kind and how many people it may hold. The company’s own employee limit still applies." />
      <CardBody className="grid gap-4">
        {flash && <Alert tone={flash.tone}>{flash.text}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required>{(f) => <Input {...f} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />}</Field>
          <Field label="Short code">{(f) => <Input {...f} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={20} />}</Field>
          <Field label="Kind">{(f) => <Select {...f} value={kind} onChange={(e) => setKind(e.target.value)}>{HR_WORKSPACE_KINDS.map((k) => <option key={k} value={k}>{HR_WORKSPACE_KIND_LABEL[k]}</option>)}</Select>}</Field>
          <Field label="Employee limit" hint="Empty for no limit of its own">{(f) => <Input {...f} inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, ''))} />}</Field>
        </div>
        <Field label="Description">{(f) => <Textarea {...f} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />}</Field>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {w.status === 'active' && <Button variant="secondary" onClick={() => setStatus('suspended')}>Suspend</Button>}
            {w.status === 'suspended' && <Button variant="secondary" onClick={() => setStatus('active')}>Reactivate</Button>}
            <Button variant="danger" onClick={() => setStatus('archived')}>Archive</Button>
          </div>
          <Button onClick={save} loading={pending}>Save details</Button>
        </div>
      </CardBody>
      <StatusDialog w={w} status={status} onClose={() => setStatus(null)} />
    </Card>
  );
}

function StatusDialog({ w, status, onClose }: { w: HrWorkspaceDetail; status: 'active' | 'suspended' | 'archived' | null; onClose: () => void }) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const title = status === 'archived' ? `Archive ${w.name}?` : status === 'suspended' ? `Suspend ${w.name}?` : `Reactivate ${w.name}?`;
  const about = status === 'archived'
    ? `Its ${w.employees} ${w.employees === 1 ? 'person moves' : 'people move'} back to the central group with their history, and its admins stop running it. This cannot be undone; you can create a new HR Workspace later.`
    : status === 'suspended' ? 'Its people keep their modules, but nobody can be added, moved or given other modules until you reactivate it.' : 'Its admins can look after its people again.';
  const go = () => start(async () => {
    if (reason.trim().length < 5) { setError('Give a reason of at least 5 characters'); return; }
    const r = await setHrWorkspaceStatusAction(w.id, status!, reason.trim());
    if (!r.ok) { setError(r.message); return; }
    onClose();
    router.push(status === 'archived' ? '/hr-workspaces' : `/hr-workspaces/${w.id}`);
    router.refresh();
  });
  return (
    <Dialog open={status !== null} onClose={onClose} size="sm" title={title} description={about}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={status === 'archived' ? 'danger' : 'primary'} onClick={go} loading={pending}>{status === 'archived' ? 'Archive' : status === 'suspended' ? 'Suspend' : 'Reactivate'}</Button></>}>
      <div className="grid gap-3">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Reason" required hint="Kept in the history and the audit trail">{(f) => <Textarea {...f} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />}</Field>
      </div>
    </Dialog>
  );
}

function PeopleTab({ w, rows, query, others, central }: { w: HrWorkspaceDetail; rows: HierarchyMemberRow[]; query: string; others: Option[]; central: HierarchyMemberRow[] | null }) {
  const router = useRouter();
  const [q, setQ] = useState(query);
  const [modulesFor, setModulesFor] = useState<HierarchyMemberRow | null>(null);
  const [moving, setMoving] = useState<HierarchyMemberRow | null>(null);
  const [adding, setAdding] = useState(false);
  const active = w.status === 'active';
  return (
    <Card>
      <CardHeader
        title="People in this HR Workspace"
        description="Each person gets only the modules you tick for them, out of the ones this HR Workspace holds."
        action={w.can.transfer && active && central ? <Button onClick={() => setAdding(true)}><UserPlus className="size-4" aria-hidden />Add people</Button> : undefined}
      />
      <CardBody>
        <form className="flex max-w-md gap-2" onSubmit={(e) => { e.preventDefault(); router.push(`/hr-workspaces/${w.id}?tab=people${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`); }}>
          <Input aria-label="Search people" placeholder="Name, code or email" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button type="submit" variant="secondary"><Search className="size-4" aria-hidden />Search</Button>
        </form>
      </CardBody>
      {rows.length === 0 ? (
        <EmptyState icon={<Users className="size-5" />} title={query ? 'Nobody matches' : 'Nobody here yet'} description={w.can.transfer ? 'Add people from the central group, or add a new employee and choose this HR Workspace.' : 'New employees you add land here.'} />
      ) : (
        <Table aria-label="People">
          <THead><tr><TH>Person</TH><TH>Department</TH><TH>Modules</TH><TH className="text-right">Actions</TH></tr></THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.employeeId}>
                <TD>
                  <Link href={`/employees/${r.employeeId}`} className="font-medium hover:underline">{r.name}</Link>
                  <div className="text-xs text-fg-muted">{r.code}{r.email ? ` · ${r.email}` : ''}</div>
                </TD>
                <TD className="text-fg-muted">{r.department ?? '—'}</TD>
                <TD>
                  <span className="text-sm">{r.modules.length}</span>
                  {r.withheld.length > 0 && <span className="ml-2 text-xs text-fg-muted">{r.withheld.length} held back</span>}
                  {!r.membershipId && <div className="text-xs text-fg-subtle">No login yet</div>}
                </TD>
                <TD className="text-right">
                  <div className="flex justify-end gap-2">
                    {w.can.assignModules && r.membershipId && <Button size="sm" variant="secondary" onClick={() => setModulesFor(r)}>Modules</Button>}
                    {w.can.transfer && active && <Button size="sm" variant="ghost" onClick={() => setMoving(r)}><ArrowRightLeft className="size-4" aria-hidden />Move</Button>}
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {modulesFor && <MemberModulesDialog w={w} row={modulesFor} onClose={() => setModulesFor(null)} />}
      {moving && <MoveDialog w={w} row={moving} others={others} onClose={() => setMoving(null)} />}
      {adding && central && <AddPeopleDialog w={w} central={central} onClose={() => setAdding(false)} />}
    </Card>
  );
}

function MemberModulesDialog({ w, row, onClose }: { w: HrWorkspaceDetail; row: HierarchyMemberRow; onClose: () => void }) {
  const router = useRouter();
  const held = w.modules.filter((m) => m.state === 'granted' && !m.core);
  const [chosen, setChosen] = useState<string[]>(row.modules.filter((k) => held.some((m) => m.key === k)));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = () => start(async () => {
    const r = await setMemberModulesAction(row.employeeId, chosen, row.version, w.id);
    if (!r.ok) { setError(r.message); return; }
    onClose();
    router.refresh();
  });
  return (
    <Dialog open onClose={onClose} title={`Modules for ${row.name}`} description={`Out of the ${held.length} modules ${w.name} holds. Core HR is always on.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={save} loading={pending}>Save</Button></>}>
      <div className="grid gap-3">
        {error && <Alert tone="danger">{error}</Alert>}
        {held.length === 0 && <p className="text-sm text-fg-muted">This HR Workspace holds no modules beyond Core HR yet.</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          {held.map((m) => <Checkbox key={m.key} label={m.name} checked={chosen.includes(m.key)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, m.key] : c.filter((k) => k !== m.key)))} />)}
        </div>
      </div>
    </Dialog>
  );
}

function MoveDialog({ w, row, others, onClose }: { w: HrWorkspaceDetail; row: HierarchyMemberRow; others: Option[]; onClose: () => void }) {
  const router = useRouter();
  const [to, setTo] = useState<string>('central');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const go = () => start(async () => {
    if (reason.trim().length < 3) { setError('Give a reason of at least 3 characters'); return; }
    const r = await transferEmployeeAction(row.employeeId, to === 'central' ? null : to, reason.trim(), w.id);
    if (!r.ok) { setError(r.message); return; }
    onClose();
    router.refresh();
  });
  return (
    <Dialog open onClose={onClose} size="sm" title={`Move ${row.name}`} description="Their records and history go with them. Their modules follow the HR Workspace they move to."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={go} loading={pending}>Move</Button></>}>
      <div className="grid gap-3">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Move to">{(f) => <Select {...f} value={to} onChange={(e) => setTo(e.target.value)}><option value="central">Central group</option>{others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>}</Field>
        <Field label="Reason" required>{(f) => <Input {...f} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Relocated to the Delhi office" />}</Field>
      </div>
    </Dialog>
  );
}

function AddPeopleDialog({ w, central, onClose }: { w: HrWorkspaceDetail; central: HierarchyMemberRow[]; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const shown = central.filter((r) => `${r.name} ${r.code} ${r.email ?? ''} ${r.department ?? ''}`.toLowerCase().includes(q.toLowerCase())).slice(0, 100);
  const go = () => start(async () => {
    if (!chosen.length) { setError('Choose at least one person'); return; }
    if (reason.trim().length < 3) { setError('Give a reason of at least 3 characters'); return; }
    const r = await assignToHrWorkspaceAction(w.id, chosen, reason.trim());
    if (!r.ok) { setError(r.message); return; }
    onClose();
    router.refresh();
  });
  return (
    <Dialog open onClose={onClose} size="lg" title={`Add people to ${w.name}`} description="People from the central group. Their records and history go with them."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={go} loading={pending}>Add {chosen.length || ''}</Button></>}>
      <div className="grid gap-3">
        {error && <Alert tone="danger">{error}</Alert>}
        <Input aria-label="Find people" placeholder="Name, code, email or department" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="grid max-h-72 gap-1.5 overflow-y-auto rounded-lg border border-border p-2">
          {shown.length === 0 && <p className="px-1 text-[0.8125rem] text-fg-muted">{central.length ? 'Nobody matches.' : 'Nobody is in the central group.'}</p>}
          {shown.map((r) => <Checkbox key={r.employeeId} label={r.name} description={[r.code, r.department].filter(Boolean).join(' · ')} checked={chosen.includes(r.employeeId)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, r.employeeId] : c.filter((x) => x !== r.employeeId)))} />)}
        </div>
        <Field label="Reason" required>{(f) => <Input {...f} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Joined the Pune branch" />}</Field>
      </div>
    </Dialog>
  );
}

function AdminsTab({ w, members }: { w: HrWorkspaceDetail; members: Option[] }) {
  const router = useRouter();
  const [chosen, setChosen] = useState(w.admins.map((a) => a.membershipId));
  const [q, setQ] = useState('');
  const [flash, setFlash] = useState<Flash>(null);
  const [pending, start] = useTransition();
  const dirty = JSON.stringify([...chosen].sort()) !== JSON.stringify(w.admins.map((a) => a.membershipId).sort());
  const shown = members.filter((m) => chosen.includes(m.id) || `${m.name} ${m.email ?? ''}`.toLowerCase().includes(q.toLowerCase())).slice(0, 60);
  const save = () => start(async () => {
    const r = await setHrWorkspaceAdminsAction(w.id, chosen);
    setFlash({ tone: r.ok ? 'success' : 'danger', text: r.ok ? (r.message ?? 'Saved') : r.message });
    if (r.ok) router.refresh();
  });
  return (
    <Card>
      <CardHeader
        title="Admins of this HR Workspace"
        description="They get the HR Workspace Admin role for this HR Workspace only: its people, their attendance, leave, documents and requests, and which of its modules each person gets. No company-wide settings, roles, billing or payroll."
        action={w.can.manage ? <Button onClick={save} disabled={!dirty} loading={pending}>Save admins</Button> : undefined}
      />
      <CardBody className="grid gap-3">
        {flash && <Alert tone={flash.tone}>{flash.text}</Alert>}
        {!w.can.manage ? (
          w.admins.length ? (
            <ul className="grid gap-2">{w.admins.map((a) => <li key={a.membershipId} className="text-sm"><span className="font-medium">{a.name ?? a.email}</span>{a.name && a.email ? <span className="text-fg-muted"> · {a.email}</span> : null}</li>)}</ul>
          ) : <p className="text-sm text-fg-muted">No admins yet.</p>
        ) : (
          <>
            <Input aria-label="Find a person" placeholder="Find a person by name or email" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-md" />
            <div className="grid gap-1.5 sm:grid-cols-2">
              {shown.map((m) => <Checkbox key={m.id} label={m.name} description={m.email} checked={chosen.includes(m.id)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, m.id] : c.filter((x) => x !== m.id)))} />)}
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function describe(changes: ConfigVersionRow['changes']): string {
  return Object.entries(changes).map(([k, v]) => {
    if (k === 'features' || k === 'withheld' || k === 'nonDelegableFeatures' || k === 'modules') {
      const from = new Set((v.from as string[] | null) ?? []);
      const to = new Set((v.to as string[] | null) ?? []);
      const added = [...to].filter((x) => !from.has(x)).map((x) => MODULE_NAME[x] ?? x);
      const removed = [...from].filter((x) => !to.has(x)).map((x) => MODULE_NAME[x] ?? x);
      const label = k === 'withheld' ? 'held back' : k === 'nonDelegableFeatures' ? 'kept at company level' : 'modules';
      return [added.length ? `${label} +${added.join(', ')}` : '', removed.length ? `${label} −${removed.join(', ')}` : ''].filter(Boolean).join('; ');
    }
    if (k === 'admins') return `admins ${((v.from as string[]) ?? []).length} → ${((v.to as string[]) ?? []).length}`;
    return `${k}: ${JSON.stringify(v.from)} → ${JSON.stringify(v.to)}`;
  }).filter(Boolean).join('; ');
}

function HistoryTab({ history, transfers }: { history: ConfigVersionRow[]; transfers: TransferRow[] }) {
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader title="Change history" description="Every change to what this HR Workspace and its people may use, with the level that made it, the values before and after, and the version." />
        {history.length === 0 ? <CardBody><p className="text-sm text-fg-muted">No changes yet.</p></CardBody> : (
          <Table aria-label="Change history">
            <THead><tr><TH>When</TH><TH>Level</TH><TH>What</TH><TH>Change</TH><TH>By</TH></tr></THead>
            <TBody>
              {history.map((h) => (
                <TR key={h.id}>
                  <TD className="whitespace-nowrap text-fg-muted">{when(h.createdAt)}</TD>
                  <TD><Badge tone={h.level === 'console' ? 'info' : h.level === 'super' ? 'accent' : 'ember'}>{PLATFORM_LEVEL_LABEL[h.level]}</Badge></TD>
                  <TD>{ACTION_LABEL[h.action] ?? h.action}<div className="text-xs text-fg-muted">{h.targetName ?? ''} · v{h.version}</div></TD>
                  <TD className="max-w-md text-[0.8125rem]">{describe(h.changes) || '—'}</TD>
                  <TD className="text-fg-muted">{h.actorName ?? '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      <Card>
        <CardHeader title="Moves in and out" description="People who joined or left this HR Workspace, from where, to where and why." />
        {transfers.length === 0 ? <CardBody><p className="text-sm text-fg-muted">No moves yet.</p></CardBody> : (
          <Table aria-label="Moves">
            <THead><tr><TH>When</TH><TH>Person</TH><TH>From</TH><TH>To</TH><TH>Reason</TH><TH>By</TH></tr></THead>
            <TBody>
              {transfers.map((t) => (
                <TR key={t.id}>
                  <TD className="whitespace-nowrap text-fg-muted">{when(t.createdAt)}</TD>
                  <TD><Link href={`/employees/${t.employeeId}`} className="font-medium hover:underline">{t.employeeName ?? 'Employee'}</Link></TD>
                  <TD>{t.fromName ?? 'Central group'}</TD>
                  <TD>{t.toName ?? 'Central group'}</TD>
                  <TD className="max-w-xs text-[0.8125rem]">{t.reason}</TD>
                  <TD className="text-fg-muted">{t.byName ?? '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
