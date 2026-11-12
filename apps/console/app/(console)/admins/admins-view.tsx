'use client';
import { PLATFORM_ROLE_CAPABILITIES, PLATFORM_ROLES, password as passwordSchema } from '@crew/contracts';
import { Alert, Badge, Button, Card, Dialog, Field, Input, Select, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Settings2, UserPlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { z } from 'zod';
import { createAdminAction, resetAdminMfaAction, resetAdminPasswordAction, unlockAdminAction, updateAdminAction } from '../actions';
import { LocalTime } from '@/components/local-time';

export interface AdminRow { id: string; email: string; fullName: string; role: string; mfaEnabled: boolean; status: string; lastLoginAt: string | null; mustChangePassword: boolean; locked: boolean }

const ROLE_OPTIONS = [
  ['support', 'Support: view workspaces, request support access, health, audit'],
  ['billing_ops', 'Billing operations: subscriptions and prices'],
  ['viewer', 'Viewer: read-only'],
  ['super_admin', 'Super admin: everything'],
] as const;

const schema = z.object({ fullName: z.string().trim().min(1, 'Required').max(120), email: z.email('Enter a valid email'), role: z.enum(PLATFORM_ROLES), password: passwordSchema });

export function AdminsView({ rows, meId }: { rows: AdminRow[]; meId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [managing, setManaging] = useState<AdminRow | null>(null);

  return (
    <div className="grid gap-4">
      {note && <Alert tone="success">{note}</Alert>}
      <div className="flex justify-end"><Button onClick={() => setOpen(true)}><UserPlus className="size-4" /> Add admin</Button></div>
      <Card>
        <Table>
          <THead><TR><TH>Name</TH><TH>Role</TH><TH>MFA</TH><TH>Status</TH><TH>Last sign-in</TH><TH><span className="sr-only">Actions</span></TH></TR></THead>
          <TBody>
            {rows.map((a) => (
              <TR key={a.id}>
                <TD><div className="font-medium">{a.fullName}</div><div className="text-xs text-fg-subtle">{a.email}</div></TD>
                <TD title={(PLATFORM_ROLE_CAPABILITIES as Record<string, readonly string[]>)[a.role]?.join(', ')}>{a.role.replace('_', ' ')}</TD>
                <TD>{a.mfaEnabled ? <Badge tone="success">On</Badge> : <Badge tone="warning">Not enrolled</Badge>}</TD>
                <TD>
                  <div className="flex flex-wrap gap-1">
                    <Badge tone={a.status === 'active' ? 'success' : 'neutral'}>{a.status}</Badge>
                    {a.locked && <Badge tone="danger">Locked</Badge>}
                    {a.mustChangePassword && <Badge tone="warning">Temporary password</Badge>}
                  </div>
                </TD>
                <TD className="text-fg-muted">{a.lastLoginAt ? <LocalTime value={a.lastLoginAt} /> : 'Never'}</TD>
                <TD className="text-right">
                  {a.id === meId ? <span className="text-xs text-fg-subtle">You</span> : (
                    <Button size="sm" variant="ghost" onClick={() => setManaging(a)} aria-label={`Manage ${a.fullName}`}><Settings2 className="size-4" /> Manage</Button>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
      <Dialog open={open} onClose={() => setOpen(false)} title="Add console admin" description="Share the temporary password through a secure channel. They set up two-step verification at first sign-in."
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" form="admin-form" loading={pending}>Create admin</Button></>}>
        <form id="admin-form" className="grid gap-4" onSubmit={(e) => {
          e.preventDefault();
          const parsed = schema.safeParse(Object.fromEntries(new FormData(e.currentTarget)));
          if (!parsed.success) { setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message]))); return; }
          setErrors({}); setError(null);
          start(async () => {
            const r = await createAdminAction(parsed.data);
            if (!r.ok) { setError(r.message); setErrors(r.fieldErrors ?? {}); return; }
            setNote(r.message ?? 'Admin created.'); setOpen(false); router.refresh();
          });
        }}>
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Full name" error={errors.fullName} required>{(p) => <Input {...p} name="fullName" />}</Field>
          <Field label="Email" error={errors.email} required>{(p) => <Input {...p} name="email" type="email" />}</Field>
          <Field label="Role" error={errors.role} required>{(p) => (
            <Select {...p} name="role" defaultValue="support">
              {ROLE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          )}</Field>
          <Field label="Temporary password" hint="At least 12 characters" error={errors.password} required>{(p) => <Input {...p} name="password" type="password" autoComplete="new-password" />}</Field>
        </form>
      </Dialog>
      {managing && <ManageAdmin admin={managing} onClose={() => setManaging(null)} onDone={(m) => { setNote(m); setManaging(null); router.refresh(); }} />}
    </div>
  );
}

/** Another admin's account: name and role, a temporary password, two-step reset, unlock, disable or re-enable. */
function ManageAdmin({ admin, onClose, onDone }: { admin: AdminRow; onClose: () => void; onDone: (message: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState<'mfa' | 'disable' | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; message?: string; fieldErrors?: Record<string, string> }>) => {
    setError(null);
    setErrors({});
    start(async () => {
      const r = await fn();
      if (!r.ok) { setError(r.message ?? 'That did not work'); setErrors(r.fieldErrors ?? {}); return; }
      onDone(r.message ?? 'Done.');
    });
  };

  return (
    <Dialog open onClose={onClose} title={`Manage ${admin.fullName}`} description={admin.email} size="lg">
      <div className="grid gap-6">
        {error && <Alert tone="danger">{error}</Alert>}
        <form className="grid gap-3" onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const fullName = String(f.get('fullName') ?? '').trim();
          const role = String(f.get('role'));
          if (!fullName) { setErrors({ fullName: 'Required' }); return; }
          run(() => updateAdminAction(admin.id, { ...(fullName !== admin.fullName ? { fullName } : {}), ...(role !== admin.role ? { role } : {}) }));
        }}>
          <h3 className="text-sm font-semibold">Name and role</h3>
          <Field label="Full name" error={errors.fullName} required>{(p) => <Input {...p} name="fullName" defaultValue={admin.fullName} />}</Field>
          <Field label="Role" error={errors.role} hint="Changing the role signs them out so it applies at once">{(p) => (
            <Select {...p} name="role" defaultValue={admin.role}>
              {ROLE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          )}</Field>
          <div><Button type="submit" size="sm" loading={pending}>Save</Button></div>
        </form>

        <form className="grid gap-3 border-t border-border pt-4" onSubmit={(e) => {
          e.preventDefault();
          const pw = String(new FormData(e.currentTarget).get('password') ?? '');
          const parsed = passwordSchema.safeParse(pw);
          if (!parsed.success) { setErrors({ password: parsed.error.issues[0]!.message }); return; }
          run(() => resetAdminPasswordAction(admin.id, pw));
        }}>
          <h3 className="text-sm font-semibold">Forgotten password</h3>
          <p className="text-xs text-fg-muted">Set a temporary password and share it through a secure channel. They are signed out, and choose their own at next sign-in.</p>
          <Field label="Temporary password" hint="At least 12 characters" error={errors.password}>{(p) => <Input {...p} name="password" type="password" autoComplete="new-password" />}</Field>
          <div><Button type="submit" size="sm" variant="secondary" loading={pending}>Set temporary password</Button></div>
        </form>

        <div className="grid gap-3 border-t border-border pt-4">
          <h3 className="text-sm font-semibold">Sign-in problems</h3>
          <div className="flex flex-wrap gap-2">
            {admin.locked && <Button size="sm" variant="secondary" loading={pending} onClick={() => run(() => unlockAdminAction(admin.id))}>Unlock now</Button>}
            {admin.mfaEnabled && (confirm === 'mfa'
              ? <Button size="sm" variant="danger" loading={pending} onClick={() => run(() => resetAdminMfaAction(admin.id))}>Yes, remove two-step verification</Button>
              : <Button size="sm" variant="secondary" onClick={() => setConfirm('mfa')}>Reset two-step verification (lost phone)</Button>)}
            {admin.status === 'active'
              ? (confirm === 'disable'
                ? <Button size="sm" variant="danger" loading={pending} onClick={() => run(() => updateAdminAction(admin.id, { status: 'disabled' }))}>Yes, disable and sign out</Button>
                : <Button size="sm" variant="secondary" onClick={() => setConfirm('disable')}>Disable access</Button>)
              : <Button size="sm" variant="secondary" loading={pending} onClick={() => run(() => updateAdminAction(admin.id, { status: 'active' }))}>Re-enable access</Button>}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
