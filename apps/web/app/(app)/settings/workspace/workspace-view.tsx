'use client';
import { tenantSettingsInput } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, Field, Input } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveWorkspaceAction } from '../actions';

export interface TenantSettings { id: string; slug: string; name: string; status: string; region: string; timezone: string; currency: string; locale: string; countryCode: string; brandColor: string | null; requireMfa: boolean; isDemo: boolean; createdAt: string }

export function WorkspaceView({ tenant, canManage, myMfa }: { tenant: TenantSettings; canManage: boolean; myMfa: boolean }) {
  const router = useRouter();
  const [form, setForm] = useState({ name: tenant.name, timezone: tenant.timezone, currency: tenant.currency, locale: tenant.locale, brandColor: tenant.brandColor ?? '', requireMfa: tenant.requireMfa });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const [pending, start] = useTransition();
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const body = { ...form, brandColor: form.brandColor || null };
    const parsed = tenantSettingsInput.safeParse(body);
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
      return;
    }
    setErrors({});
    start(async () => {
      const r = await saveWorkspaceAction(parsed.data);
      setResult(r.ok ? { ok: true, message: r.message } : { ok: false, message: r.message });
      if (!r.ok && r.fieldErrors) setErrors(r.fieldErrors);
      if (r.ok) router.refresh();
    });
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <Card>
        <CardHeader title="General" />
        <CardBody>
          <form onSubmit={submit} className="grid gap-4">
            {result && <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>}
            <fieldset disabled={!canManage || pending} className="grid gap-4">
              <Field label="Organization name" error={errors.name} required>{(p) => <Input {...p} value={form.name} onChange={set('name')} />}</Field>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Time zone" hint="IANA name, e.g. Asia/Kolkata" error={errors.timezone}>{(p) => <Input {...p} value={form.timezone} onChange={set('timezone')} />}</Field>
                <Field label="Currency" hint="ISO 4217, e.g. INR" error={errors.currency}>{(p) => <Input {...p} value={form.currency} maxLength={3} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} />}</Field>
                <Field label="Locale" hint="e.g. en-IN" error={errors.locale}>{(p) => <Input {...p} value={form.locale} onChange={set('locale')} />}</Field>
              </div>
              <Field label="Brand colour" hint="Hex colour used for accents in your workspace. Leave empty for the CREW default." error={errors.brandColor}>
                {(p) => (
                  <div className="flex items-center gap-2">
                    <input type="color" aria-label="Pick colour" value={form.brandColor || '#4f46e5'} onChange={set('brandColor')} className="h-9 w-12 cursor-pointer rounded-md border border-border bg-bg" />
                    <Input {...p} value={form.brandColor} placeholder="#4f46e5" onChange={set('brandColor')} className="w-36" />
                  </div>
                )}
              </Field>
              <Checkbox
                label="Require two-step verification for everyone"
                description={myMfa ? 'Members without MFA will be asked to set it up before they can use the workspace.' : 'Turn on MFA for your own account first (Security page).'}
                checked={form.requireMfa}
                disabled={!myMfa && !form.requireMfa}
                onChange={set('requireMfa')}
              />
              {errors.requireMfa && <p className="text-xs text-danger">{errors.requireMfa}</p>}
            </fieldset>
            {canManage ? <div><Button type="submit" loading={pending}>Save changes</Button></div> : <p className="text-xs text-fg-subtle">You can view these settings but not change them.</p>}
          </form>
        </CardBody>
      </Card>
      <Card className="h-fit">
        <CardHeader title="Workspace" />
        <CardBody>
          <dl className="grid gap-3 text-[0.8125rem]">
            <div><dt className="text-fg-subtle">Address</dt><dd className="font-mono">{tenant.slug}</dd></div>
            <div><dt className="text-fg-subtle">Status</dt><dd><Badge tone={tenant.status === 'active' ? 'success' : 'warning'}>{tenant.status}</Badge>{tenant.isDemo && <Badge tone="ember" className="ml-2">Demo data</Badge>}</dd></div>
            <div><dt className="text-fg-subtle">Data region</dt><dd>{tenant.region}</dd><dd className="text-xs text-fg-subtle">Set at sign-up. Moving regions is handled by SAMPLEDGE support.</dd></div>
            <div><dt className="text-fg-subtle">Country</dt><dd>{tenant.countryCode}</dd></div>
            <div><dt className="text-fg-subtle">Created</dt><dd>{new Date(tenant.createdAt).toLocaleDateString()}</dd></div>
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}
