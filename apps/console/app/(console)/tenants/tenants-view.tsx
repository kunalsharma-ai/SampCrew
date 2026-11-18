'use client';
import { platformCreateTenantRequest } from '@crew/contracts';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, Select, Table, TBody, TD, TH, THead, TR, buttonClass } from '@crew/ui';
import { Building2, Copy, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { Page, TenantRow } from '@/lib/types';
import { createTenantAction } from '../actions';
import { LocalTime } from '@/components/local-time';

export function TenantsView({ page, query, canCreate, plans }: { page: Page<TenantRow>; query: { q: string; status: string }; canCreate: boolean; plans: { key: string; name: string }[] }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const href = (extra: Record<string, string>) => {
    const p = new URLSearchParams(Object.entries({ ...query, ...extra }).filter(([, v]) => v));
    return `/tenants${p.size ? `?${p}` : ''}`;
  };

  return (
    <div className="grid gap-4">
      {created && (
        <Alert tone="success" title={`${created.name} created`}>
          {created.access === 'existing_account' ? 'The owner already had a SampCrew account, so they sign in with their own password and choose this workspace.'
            : created.access === 'temporary_password' ? `The owner can sign in now at the Web Portal with ${created.email} and the temporary password you set. They choose their own password at their first sign-in. Give them the password yourself: it is never emailed.`
            : created.url ? (
              <span className="flex flex-wrap items-center gap-2">
                {created.emailQueued ? 'The invitation was emailed. You can also send the owner this link to set their password:' : 'Email delivery is not connected yet, so send the owner this link to set their password:'}
                <code className="max-w-full truncate rounded bg-surface px-2 py-0.5 font-mono text-[11px]" data-testid="owner-invite-url">{created.url}</code>
                <Button size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(created.url!)}><Copy className="size-3.5" /> Copy</Button>
              </span>
            ) : 'The owner was emailed an invitation to set their password. It expires in 7 days.'}
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <form className="flex flex-1 flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); router.push(href({ q: String(f.get('q') ?? ''), status: String(f.get('status') ?? ''), cursor: '' })); }}>
          <Input name="q" defaultValue={query.q} placeholder="Search name or address" className="w-64" aria-label="Search workspaces" />
          <Select name="status" defaultValue={query.status} className="w-40" aria-label="Status">
            <option value="">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="closed">Closed</option>
          </Select>
          <Button type="submit" variant="secondary">Filter</Button>
        </form>
        {canCreate && <Button onClick={() => setCreating(true)}><Plus className="size-4" /> New workspace</Button>}
      </div>
      <Card>
        {page.items.length === 0 ? <EmptyState icon={<Building2 className="size-6" />} title="No workspaces match" /> : (
          <Table>
            <THead><TR><TH>Workspace</TH><TH>Status</TH><TH>Plan</TH><TH className="text-right">Members</TH><TH>Region</TH><TH>Created</TH></TR></THead>
            <TBody>
              {page.items.map((t) => (
                <TR key={t.id}>
                  <TD>
                    <Link href={`/tenants/${t.id}`} className="font-medium hover:underline">{t.name}</Link>
                    {t.isDemo && <Badge tone="ember" className="ml-2">Demo</Badge>}
                    <div className="font-mono text-[11px] text-fg-subtle">{t.slug}</div>
                  </TD>
                  <TD><Badge tone={t.status === 'active' ? 'success' : 'danger'} dot>{t.status}</Badge></TD>
                  <TD className="capitalize">{t.plan ?? '—'}{t.subscriptionStatus && t.subscriptionStatus !== 'active' && <span className="ml-1 text-xs text-fg-subtle">({t.subscriptionStatus}{t.trialEndsOn ? ` to ${t.trialEndsOn}` : ''})</span>}</TD>
                  <TD className="text-right tabular">{t.activeMembers}{t.seats ? <span className="text-fg-subtle"> / {t.seats}</span> : null}</TD>
                  <TD>{t.region} · {t.countryCode}</TD>
                  <TD className="whitespace-nowrap text-fg-muted"><LocalTime value={t.createdAt} dateOnly /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      {page.nextCursor && <div className="flex justify-end"><Link className={buttonClass('secondary', 'sm')} href={href({ cursor: page.nextCursor })}>Next page</Link></div>}
      {creating && <CreateTenantDialog plans={plans} onClose={() => setCreating(false)} onCreated={(c) => { setCreated(c); setCreating(false); router.refresh(); }} />}
    </div>
  );
}

interface Created { name: string; email: string; url?: string; access: 'invitation' | 'temporary_password' | 'existing_account'; emailQueued: boolean }

function CreateTenantDialog({ plans, onClose, onCreated }: { plans: { key: string; name: string }[]; onClose: () => void; onCreated: (c: Created) => void }) {
  const [access, setAccess] = useState<'invite' | 'password'>('invite');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const { ownerPassword, ownerPasswordConfirm, ...rest } = f;
    if (access === 'password' && ownerPassword !== ownerPasswordConfirm) { setErrors({ ownerPasswordConfirm: 'The two passwords do not match' }); return; }
    const body = { ...rest, ownerAccess: access, ...(access === 'password' ? { ownerPassword } : {}), seats: Number(f.seats), trialDays: Number(f.trialDays), countryCode: f.countryCode?.toUpperCase(), currency: f.currency?.toUpperCase() };
    const parsed = platformCreateTenantRequest.safeParse(body);
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
      return;
    }
    setErrors({});
    setError(null);
    start(async () => {
      const r = await createTenantAction(parsed.data);
      if (!r.ok) { setError(r.message); setErrors(r.fieldErrors ?? {}); return; }
      onCreated({ name: parsed.data.companyName, email: parsed.data.ownerEmail, url: r.data!.ownerInviteUrl, access: r.data!.ownerAccess, emailQueued: r.data!.emailDelivery === 'queued' });
    });
  };

  return (
    <Dialog open onClose={onClose} title="New workspace" description="For sales-assisted onboarding. Choose how the owner gets in: an invitation to set their own password, or a temporary password you set now." size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" form="create-tenant" loading={pending}>Create workspace</Button></>}>
      <form id="create-tenant" onSubmit={submit} className="grid grid-cols-2 gap-4">
        {error && <Alert tone="danger" className="col-span-2">{error}</Alert>}
        <Field label="Company name" error={errors.companyName} required className="col-span-2 sm:col-span-1">{(p) => <Input {...p} name="companyName" required />}</Field>
        <Field label="Workspace address" hint="Lowercase letters, numbers and hyphens" error={errors.slug} required className="col-span-2 sm:col-span-1">{(p) => <Input {...p} name="slug" required />}</Field>
        <Field label="Owner name" error={errors.ownerName} required className="col-span-2 sm:col-span-1">{(p) => <Input {...p} name="ownerName" required />}</Field>
        <Field label="Owner email" error={errors.ownerEmail} required className="col-span-2 sm:col-span-1">{(p) => <Input {...p} name="ownerEmail" type="email" required />}</Field>
        <Field label="Plan" error={errors.planKey} required className="col-span-2 sm:col-span-1">{(p) => (
          <Select {...p} name="planKey" defaultValue={plans.some((x) => x.key === 'professional') ? 'professional' : plans[0]?.key}>{plans.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}</Select>
        )}</Field>
        <Field label="Seats" error={errors.seats} required className="col-span-2 sm:col-span-1">{(p) => <Input {...p} name="seats" type="number" min={1} defaultValue={25} required />}</Field>
        <Field label="Country" hint="ISO code, e.g. IN" error={errors.countryCode} required className="col-span-2 sm:col-span-1">{(p) => <Input {...p} name="countryCode" defaultValue="IN" maxLength={2} required />}</Field>
        <Field label="Currency" error={errors.currency} required className="col-span-2 sm:col-span-1">{(p) => <Select {...p} name="currency" defaultValue="INR"><option>INR</option><option>USD</option></Select>}</Field>
        <Field label="Time zone" error={errors.timezone} required className="col-span-2 sm:col-span-1">{(p) => <Input {...p} name="timezone" defaultValue="Asia/Kolkata" required />}</Field>
        <Field label="Trial days" hint="0 to 90" error={errors.trialDays} className="col-span-2 sm:col-span-1">{(p) => <Input {...p} name="trialDays" type="number" min={0} max={90} defaultValue={14} />}</Field>
        <fieldset className="col-span-2 grid gap-2 rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-medium">Owner&apos;s password</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="ownerAccessChoice" value="invite" checked={access === 'invite'} onChange={() => setAccess('invite')} className="mt-1" />
            <span>Send an invitation<span className="block text-xs text-fg-muted">The owner sets their own password from a link (emailed, and shown here if email is not connected).</span></span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="ownerAccessChoice" value="password" checked={access === 'password'} onChange={() => setAccess('password')} className="mt-1" data-testid="owner-access-password" />
            <span>Set a temporary password now<span className="block text-xs text-fg-muted">The owner signs in straight away and must choose their own password at the first sign-in. Ignored if the email already has a SampCrew account.</span></span>
          </label>
          {access === 'password' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Temporary password" hint="At least 12 characters, three of: lowercase, uppercase, numbers, symbols" error={errors.ownerPassword} required>{(p) => <Input {...p} name="ownerPassword" type="password" autoComplete="new-password" required minLength={12} />}</Field>
              <Field label="Repeat password" error={errors.ownerPasswordConfirm} required>{(p) => <Input {...p} name="ownerPasswordConfirm" type="password" autoComplete="new-password" required minLength={12} />}</Field>
            </div>
          )}
        </fieldset>
      </form>
    </Dialog>
  );
}
