'use client';
import { platformCreateTenantRequest } from '@crew/contracts';
import { Field, Input, Select } from '@crew/ui';
import { useState } from 'react';

/** The fields of a new Super Workspace: its name and address, the Super Workspace Admin, plan, seats and trial. */
export function WorkspaceFields({ errors, plans, defaults }: { errors: Record<string, string>; plans: { key: string; name: string }[]; defaults?: { companyName?: string; countryCode?: string } }) {
  const [access, setAccess] = useState<'invite' | 'password'>('invite');
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Super Workspace name" hint="Usually the company or the group entity" required error={errors.companyName}>{(p) => <Input {...p} name="companyName" required defaultValue={defaults?.companyName} />}</Field>
      <Field label="Workspace address" hint="Lowercase letters, numbers and hyphens" required error={errors.slug}>{(p) => <Input {...p} name="slug" required pattern="[a-z0-9-]+" />}</Field>
      <Field label="Super Workspace Admin name" required error={errors.ownerName}>{(p) => <Input {...p} name="ownerName" required />}</Field>
      <Field label="Super Workspace Admin email" required error={errors.ownerEmail}>{(p) => <Input {...p} name="ownerEmail" type="email" required />}</Field>
      <Field label="Plan" required error={errors.planKey}>{(p) => (
        <Select {...p} name="planKey" defaultValue={plans.some((x) => x.key === 'professional') ? 'professional' : plans[0]?.key}>{plans.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}</Select>
      )}</Field>
      <Field label="Seats" required error={errors.seats}>{(p) => <Input {...p} name="seats" type="number" min={1} defaultValue={25} required />}</Field>
      <Field label="Country" hint="2-letter code, e.g. IN" required error={errors.countryCode}>{(p) => <Input {...p} name="countryCode" defaultValue={defaults?.countryCode ?? 'IN'} maxLength={2} required />}</Field>
      <Field label="Currency" required error={errors.currency}>{(p) => <Select {...p} name="currency" defaultValue="INR"><option>INR</option><option>USD</option></Select>}</Field>
      <Field label="Time zone" required error={errors.timezone}>{(p) => <Input {...p} name="timezone" defaultValue="Asia/Kolkata" required />}</Field>
      <Field label="Trial days" hint="0 to 90" error={errors.trialDays}>{(p) => <Input {...p} name="trialDays" type="number" min={0} max={90} defaultValue={14} />}</Field>
      <fieldset className="grid gap-2 rounded-lg border border-border p-3 sm:col-span-2">
        <legend className="px-1 text-[13px] font-medium">How the Super Workspace Admin gets in</legend>
        <label className="flex items-start gap-2 text-[13px]">
          <input type="radio" name="ownerAccess" value="invite" checked={access === 'invite'} onChange={() => setAccess('invite')} className="mt-1" />
          <span>Send an invitation<span className="block text-[12px] text-fg-muted">They set their own password from a link (emailed, and shown here if email is not connected).</span></span>
        </label>
        <label className="flex items-start gap-2 text-[13px]">
          <input type="radio" name="ownerAccess" value="password" checked={access === 'password'} onChange={() => setAccess('password')} className="mt-1" />
          <span>Set a temporary password now<span className="block text-[12px] text-fg-muted">They must choose their own at the first sign-in. Ignored if the email already has a SampCrew account.</span></span>
        </label>
        {access === 'password' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Temporary password" hint="At least 12 characters, three of: lowercase, uppercase, numbers, symbols" required error={errors.ownerPassword}>{(p) => <Input {...p} name="ownerPassword" type="password" autoComplete="new-password" minLength={12} required />}</Field>
            <Field label="Repeat password" required error={errors.ownerPasswordConfirm}>{(p) => <Input {...p} name="ownerPasswordConfirm" type="password" autoComplete="new-password" minLength={12} required />}</Field>
          </div>
        )}
      </fieldset>
    </div>
  );
}

export function readWorkspace(form: HTMLFormElement) {
  const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
  if (f.ownerAccess === 'password' && f.ownerPassword !== f.ownerPasswordConfirm) return { ok: false as const, errors: { ownerPasswordConfirm: 'The two passwords do not match' } };
  const body = {
    companyName: f.companyName?.trim(), slug: f.slug?.trim(), ownerName: f.ownerName?.trim(), ownerEmail: f.ownerEmail?.trim(), planKey: f.planKey,
    seats: Number(f.seats), countryCode: f.countryCode?.toUpperCase(), currency: f.currency?.toUpperCase(), timezone: f.timezone, trialDays: Number(f.trialDays || 0),
    ownerAccess: f.ownerAccess === 'password' ? 'password' : 'invite', ...(f.ownerAccess === 'password' ? { ownerPassword: f.ownerPassword } : {}),
  };
  const parsed = platformCreateTenantRequest.safeParse(body);
  if (parsed.success) return { ok: true as const, data: parsed.data };
  return { ok: false as const, errors: Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])) };
}

/** What to tell the admin after a Super Workspace is created: how its admin signs in. */
export function createdNote(r: { ownerInviteUrl?: string; ownerAccess: string; emailDelivery?: string }) {
  if (r.ownerAccess === 'existing_account') return 'The Super Workspace Admin already had a SampCrew account, so they sign in with their own password and choose this workspace.';
  if (r.ownerAccess === 'temporary_password') return 'The Super Workspace Admin can sign in now with the temporary password you set. Give it to them yourself: it is never emailed.';
  if (r.ownerInviteUrl) return r.emailDelivery === 'queued' ? 'The invitation was emailed. You can also send them the link below.' : 'Email delivery is not connected yet, so send them the link below to set their password.';
  return 'The invitation was emailed. It expires in 7 days.';
}
