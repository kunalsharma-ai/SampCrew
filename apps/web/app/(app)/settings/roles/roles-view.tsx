'use client';
import { PERMISSIONS, type Scope } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Select, Textarea, cn } from '@crew/ui';
import { Lock, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import type { Role } from '@/lib/types';
import { deleteRoleAction, saveRoleAction } from '../actions';

const SCOPE_LABEL: Record<string, string> = { own: 'Own', team: 'Team', department: 'Department', entity: 'Entity', tenant: 'All' };
const MODULES = [...new Set(PERMISSIONS.map((p) => p.module))];

export function RolesView({ roles, canManage, customRolesInPlan, disabledPermissions = [] }: { roles: Role[]; canManage: boolean; customRolesInPlan: boolean; disabledPermissions?: string[] }) {
  const off = useMemo(() => new Set(disabledPermissions), [disabledPermissions]);
  const [selectedId, setSelectedId] = useState(roles[0]?.id);
  const [editor, setEditor] = useState<Role | 'new' | null>(null);
  const selected = roles.find((r) => r.id === selectedId) ?? roles[0];
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
      <Card className="h-fit">
        <CardHeader
          title="Roles"
          description={`${roles.filter((r) => r.isSystem).length} system, ${roles.filter((r) => !r.isSystem).length} custom`}
          action={canManage && customRolesInPlan ? <Button size="sm" onClick={() => setEditor('new')}><Plus className="size-4" /> New</Button> : undefined}
        />
        {!customRolesInPlan && <p className="px-5 pb-3 text-xs text-fg-subtle">Custom roles are available on the Professional plan and above.</p>}
        <ul className="border-t border-border p-2">
          {roles.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => setSelectedId(r.id)}
                aria-current={selected?.id === r.id}
                className={cn('flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[0.8125rem]', selected?.id === r.id ? 'bg-accent-subtle text-accent' : 'hover:bg-bg-subtle')}
              >
                {r.isSystem ? <Lock className="size-3.5 text-fg-subtle" aria-label="System role" /> : <ShieldCheck className="size-3.5" />}
                <span className="flex-1 font-medium">{r.name}</span>
                <span className="text-xs text-fg-subtle tabular">{r.memberCount}</span>
              </button>
            </li>
          ))}
        </ul>
      </Card>

      {selected && (
        <Card>
          <CardHeader
            title={selected.name}
            description={selected.description ?? undefined}
            action={
              !selected.isSystem && canManage ? (
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setEditor(selected)}>Edit</Button>
                  <Button size="sm" variant="ghost" disabled={pending} aria-label="Delete role" onClick={() => confirm(`Delete ${selected.name}?`) && start(async () => {
                    const r = await deleteRoleAction(selected.id);
                    if (!r.ok) setError(r.message);
                    else router.refresh();
                  })}><Trash2 className="size-4" /></Button>
                </div>
              ) : selected.isSystem ? <Badge>System role</Badge> : undefined
            }
          />
          {error && <Alert tone="danger" className="mx-5 mb-3">{error}</Alert>}
          <div className="border-t border-border">
            {MODULES.map((m) => {
              const perms = PERMISSIONS.filter((p) => p.module === m);
              const granted = perms.filter((p) => selected.grants[p.key]);
              if (!granted.length) return null;
              return (
                <div key={m} className="border-b border-border px-5 py-3 last:border-0">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">{m}</div>
                  <ul className="grid gap-1.5">
                    {granted.map((p) => (
                      <li key={p.key} className="flex items-center justify-between gap-3 text-[0.8125rem]">
                        <span className={off.has(p.key) ? 'text-fg-subtle line-through' : undefined}>{p.description}{'requiresMfa' in p && p.requiresMfa && <Badge tone="warning" className="ml-2">MFA</Badge>}{off.has(p.key) && <Badge tone="danger" className="ml-2">Switched off by SAMPLEDGE</Badge>}</span>
                        <Badge tone="accent">{SCOPE_LABEL[selected.grants[p.key]!]}</Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            {!Object.keys(selected.grants).length && <p className="px-5 py-6 text-[0.8125rem] text-fg-muted">This role grants no permissions.</p>}
          </div>
        </Card>
      )}
      {editor && <RoleEditor role={editor === 'new' ? null : editor} off={off} onClose={() => setEditor(null)} />}
    </div>
  );
}

function RoleEditor({ role, off, onClose }: { role: Role | null; off: Set<string>; onClose: () => void }) {
  const router = useRouter();
  const [grants, setGrants] = useState<Record<string, Scope>>((role?.grants as Record<string, Scope>) ?? {});
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const count = useMemo(() => Object.keys(grants).length, [grants]);
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={role ? `Edit ${role.name}` : 'New custom role'}
      description={`${count} permission${count === 1 ? '' : 's'} selected`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="role-form" loading={pending}>Save role</Button></>}
    >
      <form
        id="role-form"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          start(async () => {
            const r = await saveRoleAction(role?.id ?? null, {
              key: role ? undefined : String(f.get('key')),
              name: String(f.get('name')),
              description: String(f.get('description') || '') || undefined,
              grants: Object.entries(grants).map(([permission, scope]) => ({ permission, scope })),
            });
            if (r.ok) {
              onClose();
              router.refresh();
            } else {
              setError(r.code === 'mfa_required' ? 'Managing roles needs two-step verification. Turn it on under Security.' : r.message);
              setFe(r.fieldErrors ?? {});
            }
          });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={fe.name} required>{(p) => <Input {...p} name="name" defaultValue={role?.name} required />}</Field>
          <Field label="Key" hint="Lowercase, used in integrations" error={fe.key} required>{(p) => <Input {...p} name="key" defaultValue={role?.key} disabled={!!role} required pattern="[a-z][a-z0-9_]{2,40}" />}</Field>
        </div>
        <Field label="Description">{(p) => <Textarea {...p} name="description" defaultValue={role?.description ?? ''} />}</Field>
        {MODULES.map((m) => (
          <fieldset key={m} className="rounded-md border border-border">
            <legend className="ml-3 px-1 text-xs font-semibold uppercase tracking-wide text-fg-subtle">{m}</legend>
            <ul className="divide-y divide-border">
              {PERMISSIONS.filter((p) => p.module === m).map((p) => (
                <li key={p.key} className="flex items-center gap-3 px-3 py-2">
                  <input
                    type="checkbox"
                    id={`perm-${p.key}`}
                    className="size-4 accent-[var(--accent)]"
                    checked={!!grants[p.key]}
                    disabled={off.has(p.key) && !grants[p.key]}
                    onChange={(e) => setGrants((g) => {
                      const n = { ...g };
                      if (e.target.checked) n[p.key] = p.scopes[p.scopes.length - 1] as Scope;
                      else delete n[p.key];
                      return n;
                    })}
                  />
                  <label htmlFor={`perm-${p.key}`} className="flex-1 text-[0.8125rem]">
                    {p.description}
                    {p.phase > 1 && <span className="ml-2 text-[0.6875rem] text-fg-subtle">Phase {p.phase}</span>}
                    {off.has(p.key) && <Badge tone="danger" className="ml-2">Switched off by SAMPLEDGE</Badge>}
                  </label>
                  {grants[p.key] && (
                    <Select aria-label={`Scope for ${p.key}`} className="h-8 w-32 text-xs" value={grants[p.key]} onChange={(e) => setGrants((g) => ({ ...g, [p.key]: e.target.value as Scope }))}>
                      {p.scopes.map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
                    </Select>
                  )}
                </li>
              ))}
            </ul>
          </fieldset>
        ))}
      </form>
    </Dialog>
  );
}
