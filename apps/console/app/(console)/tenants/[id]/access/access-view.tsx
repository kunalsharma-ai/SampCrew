'use client';
import type { MemberAccessRow, WorkspaceAccess } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Input, Switch, Table, TBody, TD, TH, THead, TR, cn } from '@crew/ui';
import { Blocks, Globe, KeyRound, Search, Smartphone, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { setMemberModulesAction, switchAppsAction, switchModulesAction, switchPermissionsAction } from '../../../actions';

export type AccessTab = 'modules' | 'apps' | 'permissions' | 'people';
type Feature = WorkspaceAccess['features'][number];
type Permission = WorkspaceAccess['permissions'][number];
type Flash = { tone: 'success' | 'danger'; text: string } | null;

const TABS: { key: AccessTab; label: string; icon: React.ReactNode }[] = [
  { key: 'modules', label: 'Modules', icon: <Blocks className="size-4" aria-hidden /> },
  { key: 'apps', label: 'Web & mobile apps', icon: <Smartphone className="size-4" aria-hidden /> },
  { key: 'permissions', label: 'Permissions', icon: <KeyRound className="size-4" aria-hidden /> },
  { key: 'people', label: 'People', icon: <Users className="size-4" aria-hidden /> },
];

export function AccessView({ tenantId, tab, access, members, page, pageSize, q, canManage }: {
  tenantId: string; tab: AccessTab; access: WorkspaceAccess; members: { items: MemberAccessRow[]; total: number } | null;
  page: number; pageSize: number; q: string; canManage: boolean;
}) {
  const [flash, setFlash] = useState<Flash>(null);
  const on = access.features.filter((f) => f.effective).length;
  const off = access.permissions.filter((p) => !p.enabled).length;
  return (
    <div className="grid gap-5">
      {!canManage && <Alert tone="info">You can see these switches but not change them. Only Super admins can switch modules and permissions.</Alert>}
      {access.plan && access.plan.status !== 'active' && access.plan.status !== 'trialing' && (
        <Alert tone="warning" title={`Subscription is ${access.plan.status}`}>While the subscription is {access.plan.status}, every module is off whatever the switches say.</Alert>
      )}
      {flash && <Alert tone={flash.tone}>{flash.text}</Alert>}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] text-fg-muted">
        <span>Plan: <strong className="text-fg">{access.plan?.name ?? 'None'}</strong></span>
        <span data-testid="modules-on"><strong className="text-fg">{on}</strong> of {access.features.length} modules active</span>
        <span data-testid="permissions-off"><strong className="text-fg">{off}</strong> permissions switched off</span>
        {access.updatedAt && <span>Permissions last changed {new Date(access.updatedAt).toLocaleString()}</span>}
      </div>
      <nav aria-label="Access sections" className="flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <Link key={t.key} href={`/tenants/${tenantId}/access?tab=${t.key}`} aria-current={t.key === tab ? 'page' : undefined}
            className={cn('-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px]', t.key === tab ? 'border-accent font-medium text-fg' : 'border-transparent text-fg-muted hover:text-fg')}>
            {t.icon}{t.label}
          </Link>
        ))}
      </nav>
      {tab === 'modules' && <ModulesTab tenantId={tenantId} features={access.features} canManage={canManage} setFlash={setFlash} />}
      {tab === 'apps' && <AppsTab tenantId={tenantId} access={access} canManage={canManage} setFlash={setFlash} />}
      {tab === 'permissions' && <PermissionsTab tenantId={tenantId} access={access} canManage={canManage} setFlash={setFlash} />}
      {tab === 'people' && (canManage && members
        ? <PeopleTab tenantId={tenantId} features={access.features} members={members} page={page} pageSize={pageSize} q={q} setFlash={setFlash} />
        : <Card><EmptyState icon={<Users className="size-6" />} title="Super admins only" description="Choosing which modules each person may use is limited to Super admins, because it lists the workspace's members." /></Card>)}
    </div>
  );
}

function useSave(setFlash: (f: Flash) => void) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; message?: string }>) => start(async () => {
    const r = await fn();
    setFlash({ tone: r.ok ? 'success' : 'danger', text: r.message ?? (r.ok ? 'Saved.' : 'Something went wrong.') });
    if (r.ok) router.refresh();
  });
  return { pending, run };
}

function groupBy<T>(items: T[], key: (t: T) => string) {
  const out = new Map<string, T[]>();
  for (const i of items) out.set(key(i), [...(out.get(key(i)) ?? []), i]);
  return [...out.entries()];
}

function ModulesTab({ tenantId, features, canManage, setFlash }: { tenantId: string; features: Feature[]; canManage: boolean; setFlash: (f: Flash) => void }) {
  const { pending, run } = useSave(setFlash);
  const switchable = features.filter((f) => !f.core);
  const set = (changes: { key: string; state: 'plan' | 'on' | 'off' }[]) => run(() => switchModulesAction(tenantId, changes));
  return (
    <Card>
      <CardHeader
        title="Modules"
        description="Active modules appear in the web portal and mobile app for people whose roles allow them. Inactive modules are hidden and their API is closed. A module can be switched on even when the plan does not include it."
        action={canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => set(switchable.map((f) => ({ key: f.key, state: 'on' })))}>Activate all</Button>
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => set(switchable.map((f) => ({ key: f.key, state: 'off' })))}>Deactivate all</Button>
            <Button size="sm" variant="ghost" disabled={pending || !switchable.some((f) => f.override !== null)} onClick={() => set(switchable.filter((f) => f.override !== null).map((f) => ({ key: f.key, state: 'plan' })))}>Reset all to plan</Button>
          </div>
        ) : undefined}
      />
      <Table aria-label="Modules">
        <THead><TR><TH>Module</TH><TH>Plan</TH><TH>Set by SAMPLEDGE</TH><TH className="text-right">Active</TH></TR></THead>
        <TBody>
          {features.map((f) => (
            <TR key={f.key} data-testid={`module-${f.key}`}>
              <TD>
                <div className="font-medium text-fg">{f.name}</div>
                <div className="text-xs text-fg-subtle">{f.module} · <code>{f.key}</code>{f.blockedMembers > 0 && <> · {f.blockedMembers} {f.blockedMembers === 1 ? 'person' : 'people'} blocked</>}</div>
              </TD>
              <TD>{f.inPlan ? <Badge tone="neutral">Included</Badge> : <Badge tone="warning">Not in plan</Badge>}</TD>
              <TD>
                {f.core ? <span className="text-xs text-fg-subtle">Always on</span>
                  : f.override === null ? <span className="text-xs text-fg-subtle">Follows plan</span>
                  : (
                    <span className="inline-flex items-center gap-2">
                      <Badge tone={f.override ? 'success' : 'danger'}>{f.override ? 'Forced on' : 'Forced off'}</Badge>
                      {canManage && <button type="button" className="text-xs text-accent hover:underline disabled:opacity-50" disabled={pending} onClick={() => set([{ key: f.key, state: 'plan' }])}>Reset</button>}
                    </span>
                  )}
              </TD>
              <TD className="text-right">
                <span className="inline-flex items-center gap-2">
                  <span className={cn('text-xs', f.effective ? 'text-success' : 'text-fg-subtle')}>{f.effective ? 'Active' : 'Inactive'}</span>
                  <Switch checked={f.effective} label={`${f.name} active`} testId={`switch-module-${f.key}`} disabled={!canManage || f.core || pending} onChange={(next) => set([{ key: f.key, state: next === f.inPlan ? 'plan' : next ? 'on' : 'off' }])} />
                </span>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Card>
  );
}

/**
 * Web Portal and mobile app: each can be switched off for the whole workspace (its open sessions end), and every
 * module can be switched off in one app only. A module that is inactive for the workspace is off in both.
 */
function AppsTab({ tenantId, access, canManage, setFlash }: { tenantId: string; access: WorkspaceAccess; canManage: boolean; setFlash: (f: Flash) => void }) {
  const { pending, run } = useSave(setFlash);
  const c = access.channels;
  const webOff = new Set(c.webOff);
  const mobileOff = new Set(c.mobileOff);
  const app = (key: 'web' | 'mobile', next: boolean) => {
    const name = key === 'web' ? 'Web Portal' : 'mobile app';
    if (!next && !confirm(`Switch the ${name} off for this workspace? ${c.liveSessions[key]} open ${key} session(s) end now and nobody can sign in to the ${name} until it is switched back on.`)) return;
    run(() => switchAppsAction(tenantId, { [key]: next }));
  };
  const setModule = (key: string, web: boolean, mobile: boolean) => run(() => switchAppsAction(tenantId, { modules: [{ key, web, mobile }] }));
  const switchable = access.features.filter((f) => !f.core);
  return (
    <div className="grid gap-5">
      <div className="grid gap-4 md:grid-cols-2">
        {([['web', 'Web Portal', 'SampCrew in the browser: HR, managers and employees.', <Globe key="w" className="size-5" />], ['mobile', 'Mobile app', 'SampCrew on Android and iPhone: attendance, leave, Ask HR, approvals.', <Smartphone key="m" className="size-5" />]] as const).map(([key, title, text, icon]) => (
          <Card key={key} className="p-5" data-testid={`app-${key}`}>
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-subtle text-accent" aria-hidden>{icon}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-semibold">{title}</h3>
                  <Switch checked={c[key]} label={`${title} on`} testId={`switch-app-${key}`} disabled={!canManage || pending} onChange={(next) => app(key, next)} />
                </div>
                <p className="mt-1 text-[13px] text-fg-muted">{text}</p>
                <p className="mt-2 text-xs text-fg-subtle">{c[key] ? <>On · {c.liveSessions[key]} open session(s)</> : <span className="text-danger">Switched off: sign-in refused</span>}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader title="Modules in each app" description="Switch a module off in one app only, for example Payroll on the web but not on phones. Modules switched off for the workspace (Modules tab) are off in both apps." />
        <Table aria-label="Modules in each app">
          <THead><TR><TH>Module</TH><TH>Workspace</TH><TH className="text-right">Web Portal</TH><TH className="text-right">Mobile app</TH></TR></THead>
          <TBody>
            {switchable.map((f) => {
              const web = !webOff.has(f.key);
              const mobile = !mobileOff.has(f.key);
              return (
                <TR key={f.key} data-testid={`apps-module-${f.key}`}>
                  <TD><div className="font-medium text-fg">{f.name}</div><div className="text-xs text-fg-subtle">{f.module}</div></TD>
                  <TD>{f.effective ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>}</TD>
                  <TD className="text-right"><Switch checked={f.effective && web} label={`${f.name} in the Web Portal`} testId={`switch-web-${f.key}`} disabled={!canManage || pending || !f.effective || !c.web} onChange={(next) => setModule(f.key, next, mobile)} /></TD>
                  <TD className="text-right"><Switch checked={f.effective && mobile} label={`${f.name} in the mobile app`} testId={`switch-mobile-${f.key}`} disabled={!canManage || pending || !f.effective || !c.mobile} onChange={(next) => setModule(f.key, web, next)} /></TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}

function PermissionsTab({ tenantId, access, canManage, setFlash }: { tenantId: string; access: WorkspaceAccess; canManage: boolean; setFlash: (f: Flash) => void }) {
  const { pending, run } = useSave(setFlash);
  const [filter, setFilter] = useState('');
  const featureName = useMemo(() => new Map(access.features.map((f) => [f.key, f.name])), [access.features]);
  const shown = access.permissions.filter((p) => !filter || `${p.key} ${p.description} ${p.module}`.toLowerCase().includes(filter.toLowerCase()));
  const set = (changes: { key: string; enabled: boolean }[]) => run(() => switchPermissionsAction(tenantId, changes));
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="relative w-full max-w-sm">
          <span className="sr-only">Filter permissions</span>
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-fg-subtle" aria-hidden />
          <Input className="h-9 pl-8" placeholder="Filter permissions" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        {canManage && (
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={pending || access.permissions.every((p) => p.enabled)} onClick={() => set(access.permissions.filter((p) => !p.enabled).map((p) => ({ key: p.key, enabled: true })))}>Activate all</Button>
          </div>
        )}
      </div>
      <p className="text-xs text-fg-subtle">An inactive permission is removed from every role in this workspace, including the owner&apos;s, and the workspace cannot grant it back from Settings &gt; Roles. Turning one off takes effect on the next request.</p>
      {groupBy(shown, (p) => p.module).map(([module, perms]) => {
        const allOn = perms.every((p) => p.enabled);
        const feature = perms[0]!.feature;
        const featureOn = perms[0]!.featureOn;
        return (
          <Card key={module} data-testid={`perm-group-${module}`}>
            <CardHeader
              title={module}
              description={feature && !featureOn ? `The ${featureName.get(feature) ?? feature} module is inactive, so these permissions have no effect until it is switched on.` : `${perms.filter((p) => p.enabled).length} of ${perms.length} active`}
              action={canManage ? (
                <span className="inline-flex items-center gap-2 text-xs text-fg-muted">
                  All
                  <Switch checked={allOn} label={`All ${module} permissions active`} disabled={pending} onChange={(next) => set(perms.filter((p) => p.enabled !== next).map((p) => ({ key: p.key, enabled: next })))} />
                </span>
              ) : undefined}
            />
            <ul className="divide-y divide-border border-t border-border">
              {perms.map((p) => (
                <li key={p.key} className="flex items-center gap-4 px-5 py-2.5" data-testid={`perm-${p.key}`}>
                  <div className="min-w-0 flex-1">
                    <div className={cn('text-[13px]', p.enabled ? 'text-fg' : 'text-fg-subtle line-through')}>{p.description}{p.sensitive && <Badge tone="warning" className="ml-2">Sensitive</Badge>}</div>
                    <div className="text-xs text-fg-subtle"><code>{p.key}</code> · granted by {p.roles} {p.roles === 1 ? 'role' : 'roles'} to {p.members} {p.members === 1 ? 'member' : 'members'}</div>
                  </div>
                  <span className={cn('text-xs', p.enabled ? 'text-success' : 'text-fg-subtle')}>{p.enabled ? 'Active' : 'Inactive'}</span>
                  <Switch checked={p.enabled} label={`${p.key} active`} testId={`switch-perm-${p.key}`} disabled={!canManage || pending} onChange={(next) => set([{ key: p.key, enabled: next }])} />
                </li>
              ))}
            </ul>
          </Card>
        );
      })}
      {!shown.length && <Card><EmptyState title="No permissions match" /></Card>}
    </div>
  );
}

function PeopleTab({ tenantId, features, members, page, pageSize, q, setFlash }: {
  tenantId: string; features: Feature[]; members: { items: MemberAccessRow[]; total: number }; page: number; pageSize: number; q: string; setFlash: (f: Flash) => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<MemberAccessRow | null>(null);
  const [search, setSearch] = useState(q);
  const pages = Math.max(1, Math.ceil(members.total / pageSize));
  const go = (p: number, query = q) => router.push(`/tenants/${tenantId}/access?tab=people&page=${p}${query ? `&q=${encodeURIComponent(query)}` : ''}`);
  const name = new Map(features.map((f) => [f.key, f.name]));
  return (
    <Card>
      <CardHeader title="Module access per person" description="Everyone gets every active module their roles allow, unless you take a module away from them here. Account details only: no HR records are shown." />
      <form className="flex gap-2 px-5 pb-4" onSubmit={(e) => { e.preventDefault(); go(1, search.trim()); }}>
        <label className="relative w-full max-w-sm">
          <span className="sr-only">Search people</span>
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-fg-subtle" aria-hidden />
          <Input className="h-9 pl-8" placeholder="Search by name or email" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <Button type="submit" size="sm" variant="secondary">Search</Button>
      </form>
      {members.items.length === 0 ? <EmptyState title="No people found" /> : (
        <Table aria-label="People">
          <THead><TR><TH>Person</TH><TH>Roles</TH><TH>Modules</TH><TH /></TR></THead>
          <TBody>
            {members.items.map((m) => (
              <TR key={m.membershipId} data-testid={`member-${m.email}`}>
                <TD><div className="font-medium text-fg">{m.fullName}</div><div className="text-xs text-fg-subtle">{m.email}{m.status !== 'active' && <> · {m.status}</>}</div></TD>
                <TD className="text-xs text-fg-muted">{m.roles.join(', ') || 'No roles'}</TD>
                <TD>
                  {m.blockedFeatures.length === 0 ? <Badge tone="success">All active modules</Badge> : (
                    <div className="flex flex-wrap gap-1">{m.blockedFeatures.map((k) => <Badge key={k} tone="danger">No {name.get(k) ?? k}</Badge>)}</div>
                  )}
                </TD>
                <TD className="text-right"><Button size="sm" variant="secondary" onClick={() => setEditing(m)}>Choose modules</Button></TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {pages > 1 && (
        <div className="flex items-center justify-between border-t border-border px-5 py-3 text-xs text-fg-muted">
          <span>{members.total} people · page {page} of {pages}</span>
          <span className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => go(page - 1)}>Previous</Button>
            <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => go(page + 1)}>Next</Button>
          </span>
        </div>
      )}
      {editing && <MemberDialog tenantId={tenantId} member={editing} features={features} onClose={() => setEditing(null)} setFlash={setFlash} />}
    </Card>
  );
}

function MemberDialog({ tenantId, member, features, onClose, setFlash }: { tenantId: string; member: MemberAccessRow; features: Feature[]; onClose: () => void; setFlash: (f: Flash) => void }) {
  const router = useRouter();
  const [blocked, setBlocked] = useState(new Set(member.blockedFeatures));
  const [pending, start] = useTransition();
  const switchable = features.filter((f) => !f.core);
  const toggle = (key: string, allowed: boolean) => setBlocked((b) => { const n = new Set(b); if (allowed) n.delete(key); else n.add(key); return n; });
  return (
    <Dialog open onClose={onClose} size="lg" title={`Modules for ${member.fullName}`} description="Switch off any module this person should not use. Their roles still decide what they can do inside the modules left on."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button loading={pending} onClick={() => start(async () => {
          const r = await setMemberModulesAction(tenantId, member.membershipId, [...blocked].sort());
          setFlash({ tone: r.ok ? 'success' : 'danger', text: r.ok ? `Saved module access for ${member.fullName}.` : r.message ?? 'Something went wrong.' });
          if (r.ok) { onClose(); router.refresh(); }
        })}>Save</Button>
      </>}>
      <div className="mb-3 flex gap-2">
        <Button size="sm" variant="secondary" onClick={() => setBlocked(new Set())}>Allow all</Button>
        <Button size="sm" variant="secondary" onClick={() => setBlocked(new Set(switchable.map((f) => f.key)))}>Block all</Button>
      </div>
      <ul className="grid gap-1 sm:grid-cols-2">
        {switchable.map((f) => {
          const allowed = !blocked.has(f.key);
          return (
            <li key={f.key} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium">{f.name}</div>
                <div className="text-xs text-fg-subtle">{f.effective ? (allowed ? 'Allowed' : 'Blocked for this person') : 'Inactive for the whole workspace'}</div>
              </div>
              <Switch checked={allowed && f.effective} label={`${f.name} allowed for ${member.fullName}`} testId={`member-switch-${f.key}`} disabled={!f.effective} onChange={(next) => toggle(f.key, next)} />
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
