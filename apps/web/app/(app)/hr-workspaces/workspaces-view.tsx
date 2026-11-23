'use client';
import { HR_WORKSPACE_KIND_LABEL, HR_WORKSPACE_KINDS, type HierarchyOverview, type HrWorkspaceSummary, type WorkspaceLimits } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, Dialog, EmptyState, Field, Input, Select, Stat, Textarea } from '@crew/ui';
import { Building2, ChevronRight, Network, Plus, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { WorkspaceLimitsCard } from '@/components/workspace-limits';
import { createHrWorkspaceAction } from './actions';
import { ModulePicker } from './module-picker';
import { moduleStates } from './modules';

type Option = { id: string; name: string; email?: string };

const STATUS_TONE = { active: 'success', suspended: 'warning', archived: 'neutral' } as const;

export function WorkspacesView({ overview, limits, manage, transfer, openCreate, members, departments, locations }: {
  overview: HierarchyOverview;
  /** The company's plan-based HR Workspace and Employee Workspace limits (Super Workspace only). */
  limits: WorkspaceLimits | null;
  manage: boolean;
  transfer: boolean;
  openCreate: boolean;
  members: Option[];
  departments: Option[];
  locations: Option[];
}) {
  const [creating, setCreating] = useState(openCreate && manage);
  const { company, central, hrWorkspaces } = overview;
  const delegable = company.features.filter((k) => !company.nonDelegable.includes(k)).length;
  // The API decides (and refuses at the limit); the screen shows the same Used / Maximum and closes the button.
  const atLimit = limits ? limits.hr.reached : company.hrWorkspaceLimit !== null && hrWorkspaces.length >= company.hrWorkspaceLimit;
  return (
    <div className="grid gap-6">
      {manage && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="HR Workspaces" value={limits ? limits.hr.text : company.hrWorkspaceLimit === null ? hrWorkspaces.length : `${hrWorkspaces.length} / ${company.hrWorkspaceLimit}`} icon={<Network className="size-4" />} />
          <Stat label="Central group" value={central.employees} hint="People the company runs itself" icon={<Building2 className="size-4" />} />
          <Stat label="Employees" value={company.employeeLimit === null ? company.employees : `${company.employees} of ${company.employeeLimit}`} icon={<Users className="size-4" />} />
          <Stat label="Modules you can pass down" value={`${delegable} of ${company.features.length}`} hint={company.nonDelegable.length ? `${company.nonDelegable.length} kept at company level by SAMPLEDGE` : undefined} />
        </div>
      )}

      {manage && limits && <WorkspaceLimitsCard limits={limits} />}

      {manage && (
        <Card>
          <CardHeader
            title="How access flows"
            description="SAMPLEDGE decides what your company holds. You give each HR Workspace a part of that, and its admins give each of their people a part of theirs. Nobody can pass down more than they hold, and SampCrew checks this on every request."
          />
          <CardBody>
            <ol className="flex flex-wrap items-center gap-2 text-sm" aria-label="Levels">
              {['SAMPLEDGE Console', company.name, 'HR Workspaces', 'Employees'].map((l, i, all) => (
                <li key={l} className="flex items-center gap-2">
                  <span className="rounded-full border border-border bg-surface px-3 py-1 font-medium">{l}</span>
                  {i < all.length - 1 && <ChevronRight className="size-4 text-fg-subtle" aria-hidden />}
                </li>
              ))}
            </ol>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          title={manage ? 'Your HR Workspaces' : 'HR Workspaces you run'}
          description={manage ? 'Open one to change its modules, admins and people.' : 'Open one to look after its people and choose the modules each of them gets.'}
          action={manage ? <Button onClick={() => setCreating(true)} disabled={atLimit} title={atLimit ? `HR Workspaces limit reached (${limits?.hr.text ?? 'plan limit'}). Upgrade the plan to add more.` : undefined} data-testid="new-hr-workspace"><Plus className="size-4" aria-hidden />New HR Workspace</Button> : undefined}
        />
        {hrWorkspaces.length === 0 ? (
          <EmptyState
            icon={<Network className="size-5" />}
            title={manage ? 'No HR Workspaces yet' : 'You do not run an HR Workspace'}
            description={manage ? 'Everyone is in the central group. Create an HR Workspace for a branch, department or region when someone else should look after its people.' : 'The Super Workspace names the admins of each HR Workspace.'}
            action={manage ? <Button onClick={() => setCreating(true)} disabled={atLimit}><Plus className="size-4" aria-hidden />New HR Workspace</Button> : undefined}
          />
        ) : (
          <ul className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
            {hrWorkspaces.map((w) => <WorkspaceCard key={w.id} w={w} />)}
            {manage && (
              <li>
                <Link href="/hr-workspaces/central" className="flex h-full min-h-32 flex-col justify-between rounded-xl border border-dashed border-border p-4 transition-colors hover:border-accent/60 hover:bg-accent-subtle/30">
                  <span className="text-sm font-semibold">Central group</span>
                  <span className="text-[0.8125rem] text-fg-muted">{central.employees} {central.employees === 1 ? 'person' : 'people'} run by the company. {transfer ? 'Move people into an HR Workspace from here.' : ''}</span>
                </Link>
              </li>
            )}
          </ul>
        )}
      </Card>

      {manage && (
        <CreateDialog
          open={creating}
          onClose={() => setCreating(false)}
          companyFeatures={company.features}
          nonDelegable={company.nonDelegable}
          members={members}
          departments={departments}
          locations={locations}
        />
      )}
    </div>
  );
}

function WorkspaceCard({ w }: { w: HrWorkspaceSummary }) {
  return (
    <li>
      <Link href={`/hr-workspaces/${w.id}`} className="group flex h-full flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-card transition hover:-translate-y-0.5 hover:border-accent/60 motion-reduce:transition-none motion-reduce:hover:translate-y-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{w.name}</div>
            <div className="text-xs text-fg-muted">{HR_WORKSPACE_KIND_LABEL[w.kind]}{w.code ? ` · ${w.code}` : ''}</div>
          </div>
          <Badge tone={STATUS_TONE[w.status]} dot>{w.status[0]!.toUpperCase() + w.status.slice(1)}</Badge>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem] text-fg-muted">
          <span>{w.employees}{w.maxEmployees >= 0 ? ` of ${w.maxEmployees}` : ''} {w.employees === 1 ? 'person' : 'people'}</span>
          <span>{w.features.length} {w.features.length === 1 ? 'module' : 'modules'}</span>
        </div>
        <div className="mt-auto truncate text-xs text-fg-subtle">
          {w.admins.length ? `Run by ${w.admins.map((a) => a.name ?? a.email).join(', ')}` : 'No admin yet'}
        </div>
      </Link>
    </li>
  );
}

function CreateDialog({ open, onClose, companyFeatures, nonDelegable, members, departments, locations }: {
  open: boolean; onClose: () => void; companyFeatures: string[]; nonDelegable: string[]; members: Option[]; departments: Option[]; locations: Option[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<string>('department');
  const [description, setDescription] = useState('');
  const [features, setFeatures] = useState<string[]>([]);
  const [limit, setLimit] = useState('');
  const [admins, setAdmins] = useState<string[]>([]);
  const [adminQuery, setAdminQuery] = useState('');
  const [deptIds, setDeptIds] = useState<string[]>([]);
  const [locIds, setLocIds] = useState<string[]>([]);
  const modules = useMemo(() => moduleStates(features, companyFeatures, nonDelegable), [features, companyFeatures, nonDelegable]);
  const shownMembers = members.filter((m) => `${m.name} ${m.email ?? ''}`.toLowerCase().includes(adminQuery.toLowerCase())).slice(0, 30);
  const toggle = (list: string[], set: (v: string[]) => void, id: string, on: boolean) => set(on ? [...list, id] : list.filter((x) => x !== id));

  const submit = () => {
    const e: Record<string, string> = {};
    if (name.trim().length < 2) e.name = 'At least 2 characters';
    if (code.trim() && !/^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$/.test(code.trim())) e.code = 'Use 2 to 20 letters, digits, - or _';
    if (limit.trim() && !(Number.isInteger(Number(limit)) && Number(limit) >= 1)) e.maxEmployees = 'A whole number, at least 1, or leave it empty';
    setErrors(e);
    if (Object.keys(e).length) return;
    start(async () => {
      const r = await createHrWorkspaceAction({
        name: name.trim(), code: code.trim() || undefined, kind, description: description.trim(), features,
        maxEmployees: limit.trim() ? Number(limit) : -1, adminMembershipIds: admins, departmentIds: deptIds, locationIds: locIds,
      });
      if (!r.ok) { setError(r.message); if (r.fieldErrors) setErrors(r.fieldErrors); return; }
      onClose();
      router.push(`/hr-workspaces/${r.data!.id}`);
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="New HR Workspace"
      description="A department, branch or region with its own admins. Give it only the modules its people need; you can change this later."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={pending}>Create HR Workspace</Button></>}
    >
      <div className="grid gap-5">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required error={errors.name}>{(f) => <Input {...f} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Pune branch" />}</Field>
          <Field label="Short code" hint="Optional, such as PUNE" error={errors.code}>{(f) => <Input {...f} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={20} />}</Field>
          <Field label="Kind">{(f) => <Select {...f} value={kind} onChange={(e) => setKind(e.target.value)}>{HR_WORKSPACE_KINDS.map((k) => <option key={k} value={k}>{HR_WORKSPACE_KIND_LABEL[k]}</option>)}</Select>}</Field>
          <Field label="Employee limit" hint="Empty for no limit of its own" error={errors.maxEmployees}>{(f) => <Input {...f} inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, ''))} />}</Field>
        </div>
        <Field label="Description">{(f) => <Textarea {...f} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />}</Field>

        <section className="grid gap-2">
          <h3 className="text-sm font-semibold">Modules</h3>
          <p className="text-[0.8125rem] text-fg-muted">Locked modules are not in your company’s plan, or SAMPLEDGE keeps them at company level.</p>
          <ModulePicker modules={modules} value={features} onChange={setFeatures} />
        </section>

        <section className="grid gap-2">
          <h3 className="text-sm font-semibold">Admins</h3>
          <p className="text-[0.8125rem] text-fg-muted">They get the HR Workspace Admin role, limited to this HR Workspace’s people. You can add them later too.</p>
          <Input aria-label="Find a person" placeholder="Find a person by name or email" value={adminQuery} onChange={(e) => setAdminQuery(e.target.value)} />
          <div className="grid max-h-48 gap-1.5 overflow-y-auto rounded-lg border border-border p-2">
            {shownMembers.length === 0 && <p className="px-1 text-[0.8125rem] text-fg-muted">Nobody matches.</p>}
            {shownMembers.map((m) => <Checkbox key={m.id} label={m.name} description={m.email} checked={admins.includes(m.id)} onChange={(e) => toggle(admins, setAdmins, m.id, e.target.checked)} />)}
          </div>
        </section>

        {(departments.length > 0 || locations.length > 0) && (
          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium">Departments and locations it usually looks after (optional)</summary>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div className="grid content-start gap-1.5">
                <span className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Departments</span>
                {departments.map((d) => <Checkbox key={d.id} label={d.name} checked={deptIds.includes(d.id)} onChange={(e) => toggle(deptIds, setDeptIds, d.id, e.target.checked)} />)}
              </div>
              <div className="grid content-start gap-1.5">
                <span className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Locations</span>
                {locations.map((l) => <Checkbox key={l.id} label={l.name} checked={locIds.includes(l.id)} onChange={(e) => toggle(locIds, setLocIds, l.id, e.target.checked)} />)}
              </div>
            </div>
          </details>
        )}
      </div>
    </Dialog>
  );
}
