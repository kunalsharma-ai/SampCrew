'use client';
import { isFeatureAction, type FeatureLevelRow } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, FeatureSwitchBoard, Select, Switch, Table, TBody, TD, TH, THead, TR, cn } from '@crew/ui';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { useMfaRetry } from '@/components/mfa-step-up';
import type { Me } from '@/lib/types';
import { resetRoleAction, setFeatureLevelsAction, setModulesAction, setRoleGrantsAction } from './actions';
import type { Matrix, MatrixRole, ModuleRow } from './types';

const TABS = [
  { key: 'features', label: 'Feature management' },
  { key: 'modules', label: 'Module access' },
  { key: 'permissions', label: 'Access levels' },
  { key: 'settings', label: 'Module settings' },
];
const SCOPE_LABEL: Record<string, string> = { own: 'Own records', team: 'Their team', department: 'Their department', entity: 'Their legal entity', tenant: 'Whole workspace' };
const BLOCK_LABEL: Record<string, string> = { not_in_plan: 'Not in your plan', workspace_off: 'Switched off by SAMPLEDGE', member_blocked: 'Not for you', channel_off: 'Off in this app' };

/** Settings pages for each module, shown when the member may open them. */
const SETTINGS: { href: string; label: string; about: string; permission: string; feature?: string }[] = [
  { href: '/settings/forms', label: 'Form management', about: 'Every form (Add Employee, Employee profile, Leave request, assets, verification, candidates, clients): built-in and custom fields, set by the Super Workspace.', permission: 'fields:manage' },
  { href: '/settings/roles', label: 'Custom roles', about: 'Create roles of your own, such as Payroll checker.', permission: 'roles:read' },
  { href: '/people', label: 'Logins & access', about: 'Who can sign in, and which roles each person holds (and for which departments).', permission: 'users:read' },
  { href: '/organization', label: 'Company structure', about: 'Legal entities, business units, departments and locations.', permission: 'org:read' },
  { href: '/leave/manage', label: 'Leave management', about: 'Leave types and who sees them, quantities, approvals, reports and history.', permission: 'leave:allocate', feature: 'leave' },
  { href: '/settings/leave', label: 'Holidays and leave rules', about: 'Holiday calendars and the same-day leave rule.', permission: 'leave:allocate', feature: 'leave' },
  { href: '/settings/attendance', label: 'Attendance settings', about: 'Punching rules, geofences and late-coming rules.', permission: 'attendance:configure', feature: 'attendance_basic' },
  { href: '/settings/payroll', label: 'Payroll settings', about: 'Pay components, statutory settings and payslips.', permission: 'payroll:configure', feature: 'payroll' },
  { href: '/settings/onboarding', label: 'Onboarding checklists', about: 'What new joiners and HR do in the first days.', permission: 'employees:create', feature: 'onboarding' },
  { href: '/settings/recruitment', label: 'Recruitment settings', about: 'Pipelines, career site and offer letters.', permission: 'recruitment:configure', feature: 'recruitment' },
  { href: '/settings/helpdesk', label: 'Helpdesk settings', about: 'Categories, owners, response targets and articles.', permission: 'helpdesk:configure', feature: 'helpdesk' },
  { href: '/verification/agencies', label: 'Verification agencies', about: 'Outside agencies for background checks.', permission: 'bgv:manage', feature: 'background_verification' },
  { href: '/assets/categories', label: 'Asset categories', about: 'Kinds of company property and how assets are numbered.', permission: 'assets:manage', feature: 'asset_management' },
  { href: '/settings/workspace', label: 'Workspace settings', about: 'Name, logo, time zone and currency.', permission: 'tenant:read' },
  { href: '/settings/audit', label: 'Audit trail', about: 'Every change made in the workspace, with who made it.', permission: 'audit:read' },
];

export function AdminHub({ me, modules, matrix, features, tab, roleId }: { me: Me; modules: ModuleRow[] | null; matrix: Matrix | null; features: FeatureLevelRow[] | null; tab: string; roleId?: string }) {
  const router = useRouter();
  const tabs = TABS.filter((t) => (t.key === 'features' ? features && me.permissions['modules:manage'] : t.key === 'modules' ? modules : t.key === 'permissions' ? matrix : true));
  const active = tabs.some((t) => t.key === tab) ? tab : tabs[0]!.key;
  return (
    <div className="grid gap-6">
      <div role="tablist" aria-label="Super Workspace Admin" className="flex flex-wrap gap-1 border-b border-border">
        {tabs.map((t) => (
          <button key={t.key} role="tab" aria-selected={active === t.key} type="button" onClick={() => router.push(`/settings/hr-admin?tab=${t.key}`)}
            className={cn('-mb-px border-b-2 px-3 py-2 text-sm', active === t.key ? 'border-accent font-medium text-fg' : 'border-transparent text-fg-muted hover:text-fg')}>{t.label}</button>
        ))}
      </div>
      {active === 'features' && features && <Features rows={features} />}
      {active === 'modules' && modules && <Modules rows={modules} canManage={Boolean(me.permissions['modules:manage'])} />}
      {active === 'permissions' && matrix && <Permissions matrix={matrix} roleId={roleId} canManage={Boolean(me.permissions['roles:manage'])} />}
      {active === 'settings' && <SettingsLinks me={me} />}
    </div>
  );
}

const LEVEL_COLUMNS = [
  { key: 'company', label: 'Whole company', target: 'the whole company (every level)' },
  { key: 'hr', label: 'HR Workspace level', target: 'everyone with HR Workspace access' },
  { key: 'employee', label: 'Employee Workspace level', target: 'everyone with Employee Workspace access' },
];

/**
 * Feature management for the Super Workspace: each module and page, for the whole company and separately for the HR
 * Workspace and Employee Workspace levels. What SAMPLEDGE or the plan switched off shows as Restricted and cannot be
 * switched on here; an Employee Workspace switch made here is locked for HR Workspace.
 */
function Features({ rows }: { rows: FeatureLevelRow[] }) {
  const [list, setList] = useState(rows);
  const [flash, setFlash] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const withMfa = useMfaRetry();
  const change = (key: string, target: string, enabled: boolean) => start(async () => {
    const name = list.find((r) => r.key === key)?.name ?? key;
    const res = await withMfa(() => setFeatureLevelsAction([{ key, target: target as 'company' | 'hr' | 'employee', enabled }]));
    if (res.ok && res.data) setList(res.data.items);
    setFlash({ tone: res.ok ? 'success' : 'danger', text: res.ok ? `${name}: ${res.message}` : res.message });
  });
  const changeMany = (changes: { key: string; column: string; on: boolean }[]) => start(async () => {
    if (!changes.length) return;
    // The API takes up to 200 switches at a time.
    let res!: Awaited<ReturnType<typeof setFeatureLevelsAction>>;
    for (let i = 0; i < changes.length; i += 200) {
      const part = changes.slice(i, i + 200);
      res = await withMfa(() => setFeatureLevelsAction(part.map((c) => ({ key: c.key, target: c.column as 'company' | 'hr' | 'employee', enabled: c.on }))));
      if (!res.ok) break;
    }
    if (res.ok && res.data) setList(res.data.items);
    setFlash({ tone: res.ok ? 'success' : 'danger', text: res.ok ? `${changes.length} switches ${changes[0]!.on ? 'on' : 'off'}: ${res.message}` : res.message });
  });
  const board = list.map((r) => ({ key: r.key, name: r.name, module: r.module, parent: r.parent, kind: isFeatureAction(r.key) ? 'action' as const : 'page' as const, audience: r.audience, cells: { company: r.company, hr: r.hr, employee: r.employee } }));
  return (
    <Card>
      <CardHeader
        title="Feature management"
        description="Decide which modules and pages your company uses, and which of them reach the HR Workspace level and the Employee Workspace level. Super Workspace always keeps everything the company has. HR Workspace can switch Employee Workspace features off within what you leave on; what you switch off for Employee Workspace here, HR Workspace cannot switch back on."
      />
      <CardBody>
        <FeatureSwitchBoard
          rows={board}
          columns={LEVEL_COLUMNS}
          busy={pending}
          onChange={change}
          onBulkChange={changeMany}
          intro={flash ? <Alert tone={flash.tone}>{flash.text}</Alert> : <p className="text-xs text-fg-subtle">Active: on. Inherited: follows the whole-company switch. Inactive: switched off at this level, you can switch it back on. Restricted: switched off higher up (SAMPLEDGE, the plan, or the whole-company switch). Hover a label to see who switched it.</p>}
        />
      </CardBody>
    </Card>
  );
}

function Modules({ rows, canManage }: { rows: ModuleRow[]; canManage: boolean }) {
  const [list, setList] = useState(rows);
  const [flash, setFlash] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  // Switching modules needs a recent MFA check: the step-up dialog opens in place and the change is retried.
  const withMfa = useMfaRetry();
  const groups = useMemo(() => [...new Set(list.map((r) => r.module))], [list]);
  const toggle = (r: ModuleRow, enabled: boolean) => start(async () => {
    const res = await withMfa(() => setModulesAction([{ key: r.key, enabled }]));
    if (res.ok && res.data) setList(res.data);
    setFlash({ tone: res.ok ? 'success' : 'danger', text: res.ok ? `${r.name}: ${res.message}` : res.message });
  });
  return (
    <Card>
      <CardHeader title="Module access" description="Switch a module off to hide it from everyone in this workspace, on the web and in the app. Its records are kept and come back when you switch it on. Your plan decides which modules you can use." />
      {flash && <CardBody><Alert tone={flash.tone}>{flash.text}</Alert></CardBody>}
      <Table aria-label="Modules">
        <THead><tr><TH>Module</TH><TH>Area</TH><TH>Status</TH><TH className="text-right">On</TH></tr></THead>
        <TBody>
          {groups.flatMap((g) => list.filter((r) => r.module === g)).map((r) => (
            <TR key={r.key}>
              <TD className="font-medium">{r.name}</TD>
              <TD className="text-fg-muted">{r.module}</TD>
              <TD>{r.core ? <Badge>Always on</Badge> : !r.inPlan ? <Badge tone="neutral">{BLOCK_LABEL[r.blockedBy ?? 'not_in_plan'] ?? 'Not available'}</Badge> : r.switchedOffByAdmin ? <Badge tone="warning">Switched off here</Badge> : r.blockedBy ? <Badge tone="neutral">{BLOCK_LABEL[r.blockedBy] ?? r.blockedBy}</Badge> : <Badge tone="success">On</Badge>}</TD>
              <TD className="text-right"><Switch label={`${r.name} on`} checked={r.enabled} disabled={!canManage || r.core || !r.inPlan || pending} onChange={(next) => toggle(r, next)} /></TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Card>
  );
}

function Permissions({ matrix, roleId, canManage }: { matrix: Matrix; roleId?: string; canManage: boolean }) {
  const router = useRouter();
  const role = matrix.roles.find((r) => r.id === roleId) ?? matrix.roles.find((r) => r.key === 'hr_workspace') ?? matrix.roles[0]!;
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader title="Workspace access" description="Pick an access level to see and change what it may do. Limits for one person (HR Workspaces, entities, departments, areas) are set under Logins & access." />
        <CardBody className="flex flex-wrap items-end gap-3">
          <Select aria-label="Access level" value={role.id} onChange={(e) => router.push(`/settings/hr-admin?tab=permissions&role=${e.target.value}`)} className="w-72">
            {matrix.roles.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.memberCount} {r.memberCount === 1 ? 'person' : 'people'}</option>)}
          </Select>
          {role.description && <p className="text-[0.8125rem] text-fg-muted">{role.description}</p>}
        </CardBody>
      </Card>
      <RoleEditor key={role.id} matrix={matrix} role={role} canManage={canManage && !role.locked} />
    </div>
  );
}

function RoleEditor({ matrix, role, canManage }: { matrix: Matrix; role: MatrixRole; canManage: boolean }) {
  const router = useRouter();
  const [grants, setGrants] = useState<Record<string, string>>(role.grants);
  const [flash, setFlash] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const withMfa = useMfaRetry();
  const dirty = JSON.stringify(Object.entries(grants).sort()) !== JSON.stringify(Object.entries(role.grants).sort());
  const set = (perm: string, scope: string) => setGrants((g) => { const n = { ...g }; if (scope) n[perm] = scope; else delete n[perm]; return n; });
  const save = () => start(async () => {
    const r = await withMfa(() => setRoleGrantsAction(role.id, Object.entries(grants).map(([permission, scope]) => ({ permission, scope }))));
    setFlash({ tone: r.ok ? 'success' : 'danger', text: r.message ?? '' });
    if (r.ok) router.refresh();
  });
  const reset = () => start(async () => { const r = await withMfa(() => resetRoleAction(role.id)); setFlash({ tone: r.ok ? 'success' : 'danger', text: r.message ?? '' }); if (r.ok && r.data) { setGrants((r.data as { grants: Record<string, string> }).grants); router.refresh(); } });

  return (
    <>
      <Card>
        <CardHeader title="Permission matrix" description={`What ${role.name} may do in each module. A tick means at least one permission of that kind is granted.`} />
        <Table aria-label={`Permission matrix for ${role.name}`}>
          <THead><tr><TH>Module</TH>{matrix.actions.map((a) => <TH key={a.key} className="text-center">{a.label}</TH>)}</tr></THead>
          <TBody>
            {matrix.modules.map((m) => (
              <TR key={m.module}>
                <TD className="font-medium">{m.module}{!m.available && <span className="ml-2 text-xs font-normal text-fg-subtle">not in use</span>}</TD>
                {matrix.actions.map((a) => {
                  const perms = m.permissions.filter((p) => p.action === a.key);
                  const on = perms.filter((p) => grants[p.key]);
                  return <TD key={a.key} className="text-center" title={perms.map((p) => `${p.description}${grants[p.key] ? ` (${SCOPE_LABEL[grants[p.key]!] ?? grants[p.key]})` : ''}`).join('\n')}>
                    {!perms.length ? <span className="text-fg-subtle">·</span> : on.length ? <span className="font-semibold text-success" aria-label={`${on.length} of ${perms.length} granted`}>✓{perms.length > 1 ? <span className="text-xs font-normal text-fg-muted"> {on.length}/{perms.length}</span> : null}</span> : <span className="text-fg-subtle" aria-label="Not granted">—</span>}
                  </TD>;
                })}
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>

      <Card>
        <CardHeader title="Role permissions" description={role.locked ? `${role.name} always has every permission, so the workspace can never lock itself out.` : 'Choose how far each permission reaches, or No access. Permissions marked MFA need two-step verification.'}
          action={canManage ? <div className="flex gap-2">{role.canReset && <Button size="sm" variant="secondary" loading={pending} onClick={reset}>Reset to default</Button>}<Button size="sm" disabled={!dirty} loading={pending} onClick={save}>Save permissions</Button></div> : undefined} />
        {flash && <CardBody><Alert tone={flash.tone}>{flash.text}</Alert></CardBody>}
        {role.customised && <CardBody><Alert tone="info">This built-in role has been changed in your workspace. New permissions SampCrew adds later are still offered to it.</Alert></CardBody>}
        <div className="grid gap-0 divide-y divide-border">
          {matrix.modules.map((m) => (
            <details key={m.module} className="group px-5 py-3" open={m.permissions.some((p) => grants[p.key])}>
              <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium"><ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden />{m.module}<span className="text-xs font-normal text-fg-muted">{m.permissions.filter((p) => grants[p.key]).length} of {m.permissions.length}</span></summary>
              <div className="mt-3 grid gap-2">
                {m.permissions.map((p) => (
                  <div key={p.key} className="grid items-center gap-2 sm:grid-cols-[6rem_1fr_13rem]">
                    <Badge tone="neutral" className="justify-self-start">{matrix.actions.find((a) => a.key === p.action)?.label ?? p.action}</Badge>
                    <span className="text-[0.8125rem]">{p.description}<span className="ml-1 font-mono text-[0.6875rem] text-fg-subtle">{p.key}</span>{p.requiresMfa && <Badge tone="info" className="ml-2">MFA</Badge>}{p.sensitive && <Badge tone="warning" className="ml-2">Sensitive</Badge>}{p.disabledBySampledge && <Badge tone="danger" className="ml-2">Off by SAMPLEDGE</Badge>}</span>
                    <Select aria-label={`${p.description}: access`} value={grants[p.key] ?? ''} disabled={!canManage} onChange={(e) => set(p.key, e.target.value)} className="h-8">
                      <option value="">No access</option>
                      {p.scopes.map((s) => <option key={s} value={s}>{SCOPE_LABEL[s] ?? s}</option>)}
                    </Select>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      </Card>
    </>
  );
}

function SettingsLinks({ me }: { me: Me }) {
  const links = SETTINGS.filter((s) => me.permissions[s.permission] && (!s.feature || me.features.includes(s.feature)));
  return (
    <Card>
      <CardHeader title="Module settings" description="Every module's settings, in one list. Only the ones you may change are shown." />
      <CardBody className="grid gap-2 sm:grid-cols-2">
        {links.map((s) => (
          <Link key={s.href} href={s.href} className="flex items-start gap-3 rounded-lg border border-border p-3 hover:border-accent hover:bg-accent/5">
            <div className="grid gap-0.5"><span className="text-sm font-medium">{s.label}</span><span className="text-xs text-fg-muted">{s.about}</span></div>
            <ChevronRight className="ml-auto size-4 shrink-0 text-fg-subtle" aria-hidden />
          </Link>
        ))}
      </CardBody>
    </Card>
  );
}
