'use client';
import { PLATFORM_ROLE_CAPABILITIES, PLATFORM_ROLES, password as passwordSchema } from '@crew/contracts';
import { Alert, Badge, Button, Card, Dialog, Field, Input, Select, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { UserPlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { z } from 'zod';
import { createAdminAction } from '../actions';

export interface AdminRow { id: string; email: string; fullName: string; role: string; mfaEnabled: boolean; status: string; lastLoginAt: string | null }

const schema = z.object({ fullName: z.string().trim().min(1, 'Required').max(120), email: z.email('Enter a valid email'), role: z.enum(PLATFORM_ROLES), password: passwordSchema });

export function AdminsView({ rows }: { rows: AdminRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="grid gap-4">
      {note && <Alert tone="success">{note}</Alert>}
      <div className="flex justify-end"><Button onClick={() => setOpen(true)}><UserPlus className="size-4" /> Add admin</Button></div>
      <Card>
        <Table>
          <THead><TR><TH>Name</TH><TH>Role</TH><TH>MFA</TH><TH>Status</TH><TH>Last sign-in</TH></TR></THead>
          <TBody>
            {rows.map((a) => (
              <TR key={a.id}>
                <TD><div className="font-medium">{a.fullName}</div><div className="text-xs text-fg-subtle">{a.email}</div></TD>
                <TD title={(PLATFORM_ROLE_CAPABILITIES as Record<string, readonly string[]>)[a.role]?.join(', ')}>{a.role.replace('_', ' ')}</TD>
                <TD>{a.mfaEnabled ? <Badge tone="success">On</Badge> : <Badge tone="warning">Not enrolled</Badge>}</TD>
                <TD><Badge tone={a.status === 'active' ? 'success' : 'neutral'}>{a.status}</Badge></TD>
                <TD className="text-fg-muted">{a.lastLoginAt ? new Date(a.lastLoginAt).toLocaleString() : 'Never'}</TD>
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
              <option value="support">Support: view workspaces, request support access, health, audit</option>
              <option value="billing_ops">Billing operations: subscriptions and prices</option>
              <option value="viewer">Viewer: read-only</option>
              <option value="super_admin">Super admin: everything</option>
            </Select>
          )}</Field>
          <Field label="Temporary password" hint="At least 12 characters" error={errors.password} required>{(p) => <Input {...p} name="password" type="password" autoComplete="new-password" />}</Field>
        </form>
      </Dialog>
    </div>
  );
}
