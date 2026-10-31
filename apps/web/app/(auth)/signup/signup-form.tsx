'use client';
import { Alert, Button, Checkbox, Field, Input, Select } from '@crew/ui';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { signupAction } from '../actions';

const COUNTRIES = [
  { code: 'IN', name: 'India', currency: 'INR', tz: 'Asia/Kolkata' },
  { code: 'AE', name: 'United Arab Emirates', currency: 'AED', tz: 'Asia/Dubai' },
  { code: 'GB', name: 'United Kingdom', currency: 'GBP', tz: 'Europe/London' },
  { code: 'US', name: 'United States', currency: 'USD', tz: 'America/New_York' },
  { code: 'SG', name: 'Singapore', currency: 'SGD', tz: 'Asia/Singapore' },
  { code: 'DE', name: 'Germany', currency: 'EUR', tz: 'Europe/Berlin' },
  { code: 'AU', name: 'Australia', currency: 'AUD', tz: 'Australia/Sydney' },
  { code: 'SA', name: 'Saudi Arabia', currency: 'SAR', tz: 'Asia/Riyadh' },
];

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export function SignupForm() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [company, setCompany] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const country = COUNTRIES.find((c) => c.code === f.get('countryCode'))!;
        setError(null);
        setFe({});
        start(async () => {
          const r = await signupAction({
            companyName: company, slug, fullName: f.get('fullName'), email: f.get('email'), password: f.get('password'),
            countryCode: country.code, currency: country.currency, timezone: country.tz, acceptTerms: f.get('acceptTerms') === 'on',
          });
          if (r && !r.ok) {
            setError(r.message);
            setFe(r.fieldErrors ?? {});
          }
        });
      }}
    >
      <div className="mb-1">
        <h2 className="text-2xl font-semibold tracking-tight">Create your workspace</h2>
        <p className="mt-1 text-sm text-fg-muted">14-day Professional trial. No card needed.</p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Company name" error={fe.companyName} required>
        {(p) => <Input {...p} value={company} onChange={(e) => { setCompany(e.target.value); if (!slugTouched) setSlug(slugify(e.target.value)); }} required autoFocus />}
      </Field>
      <Field label="Workspace address" hint={slug ? `Your team signs in to the "${slug}" workspace` : 'Lowercase letters, numbers and hyphens'} error={fe.slug} required>
        {(p) => <Input {...p} value={slug} onChange={(e) => { setSlugTouched(true); setSlug(slugify(e.target.value)); }} required minLength={3} />}
      </Field>
      <Field label="Country of your main entity" error={fe.countryCode} required>
        {(p) => (
          <Select {...p} name="countryCode" defaultValue="IN">
            {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </Select>
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Your full name" error={fe.fullName} required>{(p) => <Input {...p} name="fullName" autoComplete="name" required />}</Field>
        <Field label="Work email" error={fe.email} required>{(p) => <Input {...p} name="email" type="email" autoComplete="email" required />}</Field>
      </div>
      <Field label="Password" hint="At least 12 characters, mixing letters, numbers and symbols" error={fe.password} required>
        {(p) => <Input {...p} name="password" type="password" autoComplete="new-password" required minLength={12} />}
      </Field>
      <Checkbox name="acceptTerms" required label="I agree to the SAMPLEDGE terms of service and privacy notice" />
      {fe.acceptTerms && <p className="-mt-2 text-xs text-danger">{fe.acceptTerms}</p>}
      <Button type="submit" size="lg" loading={pending}>Create workspace</Button>
      <p className="text-center text-[13px] text-fg-muted">
        Already have an account? <Link href="/login" className="font-medium text-accent hover:underline">Sign in</Link>
      </p>
    </form>
  );
}
