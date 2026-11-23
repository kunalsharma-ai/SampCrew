'use client';
import { CONSOLE_AREA_LABEL, CONSOLE_PERMISSION_AREAS, CONSOLE_PERMISSIONS, withNeededPermissions, type ConsoleRole } from '@crew/contracts';
import { Alert, Badge, Button, Card, Dialog, Field, Input, Textarea, cn } from '@crew/ui';
import { Check, Lock, Pencil, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Fragment, useState, useTransition } from 'react';
import { archiveRoleAction, saveRoleAction } from '../console-actions';

export function RolesView({ roles, canManage }: { roles: ConsoleRole[]; canManage: boolean }) {
  const [editing, setEditing] = useState<ConsoleRole | 'new' | null>(null);
  const shown = roles.filter((r) => !r.archived);
  return (
    <div className="grid gap-4">
      {canManage && <div className="flex justify-end"><Button onClick={() => setEditing('new')} data-testid="role-new"><Plus className="size-4" aria-hidden />New role</Button></div>}
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-[12.5px]" aria-label="Permissions by role" data-testid="role-matrix">
          <thead className="sticky top-0 bg-surface">
            <tr className="border-b border-border">
              <th className="px-4 py-3 font-medium text-fg-muted">Permission</th>
              {shown.map((r) => (
                <th key={r.key} className="px-2 py-3 text-center align-bottom font-medium">
                  <div className="flex flex-col items-center gap-1">
                    <span>{r.name}</span>
                    <span className="text-[11px] font-normal text-fg-subtle">{r.admins} admin{r.admins === 1 ? '' : 's'}</span>
                    {canManage && (r.key === 'super_admin' ? <Lock className="size-3.5 text-fg-subtle" aria-label="Fixed: always every permission" /> : <button type="button" onClick={() => setEditing(r)} className="rounded p-0.5 text-accent hover:bg-bg-subtle" aria-label={`Edit ${r.name}`} data-testid={`role-edit-${r.key}`}><Pencil className="size-3.5" /></button>)}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CONSOLE_PERMISSION_AREAS.map((area) => (
              <Fragment key={area}>
                <tr className="bg-bg-subtle/60"><td colSpan={shown.length + 1} className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{CONSOLE_AREA_LABEL[area]}</td></tr>
                {CONSOLE_PERMISSIONS.filter((p) => p.area === area).map((p) => (
                  <tr key={p.key} className="border-b border-border/60">
                    <td className="px-4 py-2"><span className="font-medium">{p.label}</span><span className="block text-[11.5px] text-fg-muted">{p.description}</span></td>
                    {shown.map((r) => <td key={r.key} className="px-2 py-2 text-center">{r.permissions.includes(p.key) ? <Check className="mx-auto size-4 text-success" aria-label="Allowed" /> : <span className="text-fg-subtle" aria-label="Not allowed">·</span>}</td>)}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </Card>
      {editing && <RoleDialog role={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RoleDialog({ role, onClose }: { role: ConsoleRole | null; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [perms, setPerms] = useState<string[]>(role?.permissions ?? ['tenants:read']);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toggle = (key: string, on: boolean) => {
    if (on) setPerms(withNeededPermissions([...perms, key]));
    else {
      // Taking a permission away also takes away those that need it.
      const drop = new Set([key]);
      let grew = true;
      while (grew) { grew = false; for (const p of CONSOLE_PERMISSIONS) if (p.needs && drop.has(p.needs) && !drop.has(p.key)) { drop.add(p.key); grew = true; } }
      setPerms(perms.filter((p) => !drop.has(p)));
    }
  };
  return (
    <Dialog open onClose={onClose} size="lg" title={role ? `Edit ${role.name}` : 'New role'} description={role?.system ? 'A built-in role: you can change its permissions; it cannot be archived.' : 'A custom role. Give it only what the job needs.'}
      footer={<>
        {role && !role.system && <Button data-delete-area="console" data-delete={`role ${role.name}`} variant="ghost" className="mr-auto" disabled={role.admins > 0} title={role.admins > 0 ? 'Move its admins to another role first' : undefined} onClick={() => start(async () => { const r = await archiveRoleAction(role.key); if (!r.ok) { setError(r.message ?? 'Not archived'); return; } onClose(); router.refresh(); })}>Archive role</Button>}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={name.trim().length < 2} loading={pending} data-testid="role-save" onClick={() => start(async () => {
          const r = await saveRoleAction(role?.key ?? null, { name: name.trim(), description: description.trim(), permissions: perms });
          if (!r.ok) { setError(r.message ?? 'Not saved'); return; }
          onClose();
          router.refresh();
        })}>Save role</Button>
      </>}>
      <div className="grid gap-3">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} data-testid="role-name" />}</Field>
          <Field label="Description">{(p) => <Textarea {...p} value={description} onChange={(e) => setDescription(e.target.value)} rows={1} maxLength={300} />}</Field>
        </div>
        <div className="grid max-h-[50vh] gap-3 overflow-y-auto pr-1">
          {CONSOLE_PERMISSION_AREAS.map((area) => (
            <fieldset key={area} className="rounded-lg border border-border p-3">
              <legend className="px-1 text-[12px] font-semibold">{CONSOLE_AREA_LABEL[area]}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {CONSOLE_PERMISSIONS.filter((p) => p.area === area).map((p) => (
                  <label key={p.key} className={cn('flex items-start gap-2 text-[12.5px]', perms.includes(p.key) && 'text-fg')}>
                    <input type="checkbox" className="mt-0.5" checked={perms.includes(p.key)} onChange={(e) => toggle(p.key, e.target.checked)} data-testid={`perm-${p.key}`} />
                    <span><span className="font-medium">{p.label}</span>{p.needs && <Badge className="ml-1">needs {CONSOLE_PERMISSIONS.find((x) => x.key === p.needs)?.label}</Badge>}<span className="block text-[11.5px] text-fg-muted">{p.description}</span></span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
