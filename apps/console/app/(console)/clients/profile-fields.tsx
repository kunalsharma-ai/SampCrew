'use client';
import { CLIENT_INDUSTRIES, CLIENT_INDUSTRY_LABEL, CLIENT_SIZES, clientProfileInput } from '@crew/contracts';
import { Field, Input, Select, Textarea } from '@crew/ui';
import type { ClientDetail } from './client-types';

type Profile = Partial<ClientDetail['profile']>;

/**
 * The company profile fields, shared by Create Company and Edit profile. Nothing is filled in for the admin: values
 * are typed in, or saved from the company-data integration with their source shown.
 */
export function ProfileFields({ p, errors, masked, managers }: { p?: Profile; errors: Record<string, string>; masked?: boolean; managers: { id: string; name: string }[] }) {
  const lockNote = masked ? 'Hidden: your role cannot see contact details' : undefined;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Company name" required error={errors.name}>{(f) => <Input {...f} name="name" defaultValue={p?.name ?? ''} required maxLength={160} />}</Field>
      <Field label="Legal name" error={errors.legalName}>{(f) => <Input {...f} name="legalName" defaultValue={p?.legalName ?? ''} maxLength={200} />}</Field>
      <Field label="Industry" error={errors.industry}>{(f) => <Select {...f} name="industry" defaultValue={p?.industry ?? ''}><option value="">Not set</option>{CLIENT_INDUSTRIES.map((x) => <option key={x} value={x}>{CLIENT_INDUSTRY_LABEL[x]}</option>)}</Select>}</Field>
      <Field label="Company size" error={errors.companySize}>{(f) => <Select {...f} name="companySize" defaultValue={p?.companySize ?? ''}><option value="">Not set</option>{CLIENT_SIZES.map((x) => <option key={x} value={x}>{x} people</option>)}</Select>}</Field>
      <Field label="Website" hint="Company details are looked up by this domain" error={errors.website}>{(f) => <Input {...f} name="website" type="url" placeholder="https://" defaultValue={p?.website ?? ''} />}</Field>
      <Field label="LinkedIn page" error={errors.linkedin}>{(f) => <Input {...f} name="linkedin" type="url" placeholder="https://www.linkedin.com/company/…" defaultValue={p?.linkedin ?? ''} />}</Field>
      <Field label="Year founded" error={errors.foundedYear}>{(f) => <Input {...f} name="foundedYear" type="number" min={1800} max={2100} defaultValue={p?.foundedYear ?? ''} />}</Field>
      <Field label="Account manager" error={errors.accountManagerId}>{(f) => <Select {...f} name="accountManagerId" defaultValue={p?.accountManagerId ?? ''}><option value="">Nobody</option>{managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>}</Field>
      <Field label="Description" className="sm:col-span-2" error={errors.description}>{(f) => <Textarea {...f} name="description" rows={3} maxLength={2000} defaultValue={p?.description ?? ''} />}</Field>
      <fieldset className="grid gap-3 rounded-lg border border-border p-3 sm:col-span-2 sm:grid-cols-2">
        <legend className="px-1 text-[13px] font-medium">Contact</legend>
        <Field label="Company email" hint={lockNote} error={errors.email}>{(f) => <Input {...f} name="email" type="email" defaultValue={masked ? '' : p?.email ?? ''} placeholder={masked ? p?.email ?? '' : undefined} disabled={masked} />}</Field>
        <Field label="Phone" hint={lockNote} error={errors.phone}>{(f) => <Input {...f} name="phone" defaultValue={masked ? '' : p?.phone ?? ''} placeholder={masked ? p?.phone ?? '' : undefined} disabled={masked} />}</Field>
        <Field label="WhatsApp" hint={lockNote} error={errors.whatsapp}>{(f) => <Input {...f} name="whatsapp" defaultValue={masked ? '' : p?.whatsapp ?? ''} placeholder={masked ? p?.whatsapp ?? '' : undefined} disabled={masked} />}</Field>
        <Field label="Tags" hint="Comma separated" error={errors.tags}>{(f) => <Input {...f} name="tags" defaultValue={p?.tags?.join(', ') ?? ''} />}</Field>
        <Field label="Primary contact name" error={errors['primaryContact.name']}>{(f) => <Input {...f} name="pc.name" defaultValue={p?.primaryContact?.name ?? ''} maxLength={120} />}</Field>
        <Field label="Primary contact title" error={errors['primaryContact.title']}>{(f) => <Input {...f} name="pc.title" defaultValue={p?.primaryContact?.title ?? ''} maxLength={120} />}</Field>
        <Field label="Primary contact email" hint={lockNote} error={errors['primaryContact.email']}>{(f) => <Input {...f} name="pc.email" type="email" defaultValue={masked ? '' : p?.primaryContact?.email ?? ''} placeholder={masked ? p?.primaryContact?.email ?? '' : undefined} disabled={masked} />}</Field>
        <Field label="Primary contact phone" hint={lockNote} error={errors['primaryContact.phone']}>{(f) => <Input {...f} name="pc.phone" defaultValue={masked ? '' : p?.primaryContact?.phone ?? ''} placeholder={masked ? p?.primaryContact?.phone ?? '' : undefined} disabled={masked} />}</Field>
      </fieldset>
      <fieldset className="grid gap-3 rounded-lg border border-border p-3 sm:col-span-2 sm:grid-cols-3">
        <legend className="px-1 text-[13px] font-medium">Address</legend>
        <Field label="Address line 1" className="sm:col-span-2">{(f) => <Input {...f} name="a.line1" defaultValue={p?.address?.line1 ?? ''} maxLength={160} />}</Field>
        <Field label="Address line 2">{(f) => <Input {...f} name="a.line2" defaultValue={p?.address?.line2 ?? ''} maxLength={160} />}</Field>
        <Field label="City">{(f) => <Input {...f} name="a.city" defaultValue={p?.address?.city ?? ''} maxLength={80} />}</Field>
        <Field label="State or region">{(f) => <Input {...f} name="a.state" defaultValue={p?.address?.state ?? ''} maxLength={80} />}</Field>
        <Field label="Postal code">{(f) => <Input {...f} name="a.postalCode" defaultValue={p?.address?.postalCode ?? ''} maxLength={20} />}</Field>
        <Field label="Country" hint="2-letter code, e.g. IN" error={errors['address.country']}>{(f) => <Input {...f} name="a.country" defaultValue={p?.address?.country ?? p?.countryCode ?? ''} maxLength={2} />}</Field>
      </fieldset>
    </div>
  );
}

/** Reads the profile fields from a form and checks them. Masked contact fields are left out so they never overwrite. */
export function readProfile(form: HTMLFormElement, masked = false) {
  const f = new FormData(form);
  const s = (k: string) => { const v = String(f.get(k) ?? '').trim(); return v || null; };
  const year = s('foundedYear');
  const address = { line1: s('a.line1'), line2: s('a.line2'), city: s('a.city'), state: s('a.state'), postalCode: s('a.postalCode'), country: s('a.country')?.toUpperCase() ?? null };
  const body = {
    name: s('name') ?? '', legalName: s('legalName'), industry: s('industry'), companySize: s('companySize'), website: s('website'), linkedin: s('linkedin'),
    foundedYear: year ? Number(year) : null, accountManagerId: s('accountManagerId'), description: s('description'),
    tags: (s('tags') ?? '').split(',').map((t) => t.trim()).filter(Boolean),
    address: Object.values(address).some(Boolean) ? address : null,
    ...(masked ? { primaryContact: { name: s('pc.name'), title: s('pc.title') } } : {
      email: s('email'), phone: s('phone'), whatsapp: s('whatsapp'),
      primaryContact: [s('pc.name'), s('pc.title'), s('pc.email'), s('pc.phone')].some(Boolean) ? { name: s('pc.name'), title: s('pc.title'), email: s('pc.email'), phone: s('pc.phone') } : null,
    }),
  };
  const parsed = clientProfileInput.safeParse(body);
  if (parsed.success) return { ok: true as const, data: parsed.data };
  return { ok: false as const, errors: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])) };
}
