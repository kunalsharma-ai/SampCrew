'use client';
import type { ClientProfileInput } from '@crew/contracts';
import { Alert, Button, Card, CardBody, cn } from '@crew/ui';
import { Check, Copy } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState, useTransition } from 'react';
import { createClientAction } from '../../console-actions';
import { ProfileFields, readProfile } from '../profile-fields';
import { WorkspaceFields, createdNote, readWorkspace } from '../workspace-fields';

type Workspace = Extract<ReturnType<typeof readWorkspace>, { ok: true }>['data'];
const STEPS = ['Company', 'Super Workspace', 'Review'] as const;

export function NewClientWizard({ plans, managers }: { plans: { key: string; name: string }[]; managers: { id: string; name: string }[] }) {
  const [step, setStep] = useState(0);
  const [profile, setProfile] = useState<ClientProfileInput | null>(null);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ companyId: string; tenantId: string; note: string; url?: string } | null>(null);
  const [pending, start] = useTransition();
  const profileForm = useRef<HTMLFormElement>(null);
  const wsForm = useRef<HTMLFormElement>(null);

  if (done) {
    return (
      <Card data-testid="client-created">
        <CardBody className="grid gap-4">
          <Alert tone="success" title={`${profile?.name} created`}>{done.note}</Alert>
          {done.url && <span className="flex flex-wrap items-center gap-2"><code className="max-w-full truncate rounded bg-bg-subtle px-2 py-1 font-mono text-[11px]" data-testid="owner-invite-url">{done.url}</code><Button size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(done.url!)}><Copy className="size-3.5" />Copy</Button></span>}
          <div className="flex flex-wrap gap-2">
            <Link href={`/clients/${done.companyId}`} className="inline-flex h-9 items-center rounded-lg bg-accent px-3.5 text-sm font-medium text-accent-fg">Open the company</Link>
            <Link href={`/tenants/${done.tenantId}`} className="inline-flex h-9 items-center rounded-lg border border-border px-3.5 text-sm">Open the Super Workspace</Link>
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="grid gap-4">
      <ol className="flex flex-wrap gap-2" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? 'step' : undefined} className={cn('flex items-center gap-2 rounded-full border px-3 py-1 text-[12.5px]', i === step ? 'border-accent bg-accent-subtle font-medium text-accent' : i < step ? 'border-border text-fg' : 'border-border text-fg-subtle')}>
            <span className={cn('grid size-5 place-items-center rounded-full text-[11px]', i < step ? 'bg-success text-white' : 'bg-bg-subtle')}>{i < step ? <Check className="size-3" /> : i + 1}</span>{s}
          </li>
        ))}
      </ol>
      {error && <Alert tone="danger">{error}</Alert>}
      <Card>
        <CardBody>
          <form ref={profileForm} hidden={step !== 0} onSubmit={(e) => {
            e.preventDefault();
            const r = readProfile(e.currentTarget);
            if (!r.ok) { setErrors(r.errors); return; }
            setErrors({}); setProfile(r.data); setStep(1);
          }} className="grid gap-4">
            <ProfileFields errors={step === 0 ? errors : {}} managers={managers} />
            <div className="flex justify-end"><Button type="submit" data-testid="wizard-next">Next: Super Workspace</Button></div>
          </form>
          <form ref={wsForm} hidden={step !== 1} onSubmit={(e) => {
            e.preventDefault();
            const r = readWorkspace(e.currentTarget);
            if (!r.ok) { setErrors(r.errors); return; }
            setErrors({}); setWs(r.data); setStep(2);
          }} className="grid gap-4">
            {step >= 1 && <WorkspaceFields errors={step === 1 ? errors : {}} plans={plans} defaults={{ companyName: profile?.name, countryCode: profile?.address?.country ?? undefined }} />}
            <div className="flex justify-between"><Button type="button" variant="ghost" onClick={() => setStep(0)}>Back</Button><Button type="submit" data-testid="wizard-next">Next: Review</Button></div>
          </form>
          {step === 2 && profile && ws && (
            <div className="grid gap-4 text-[13px]" data-testid="wizard-review">
              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                <Item label="Company">{profile.name}{profile.legalName ? ` (${profile.legalName})` : ''}</Item>
                <Item label="Website">{profile.website ?? '—'}</Item>
                <Item label="Super Workspace">{ws.companyName} · <span className="font-mono">{ws.slug}</span></Item>
                <Item label="Super Workspace Admin">{ws.ownerName} · {ws.ownerEmail}</Item>
                <Item label="Plan">{plans.find((p) => p.key === ws.planKey)?.name ?? ws.planKey} · {ws.seats} seats · {ws.currency}</Item>
                <Item label="Trial">{ws.trialDays ? `${ws.trialDays} days` : 'No trial'}</Item>
                <Item label="Country and time zone">{ws.countryCode} · {ws.timezone}</Item>
                <Item label="Sign-in">{ws.ownerAccess === 'password' ? 'Temporary password set now' : 'Invitation link'}</Item>
              </dl>
              <div className="flex justify-between">
                <Button type="button" variant="ghost" onClick={() => setStep(1)}>Back</Button>
                <Button loading={pending} data-testid="wizard-create" onClick={() => start(async () => {
                  setError(null);
                  const r = await createClientAction({ profile, workspace: ws });
                  if (!r.ok) {
                    setError(r.message ?? 'Not created');
                    const fe = r.fieldErrors ?? {};
                    if (Object.keys(fe).length) { setErrors(Object.fromEntries(Object.entries(fe).map(([k, v]) => [k.replace(/^(workspace|profile)\./, ''), v]))); setStep(Object.keys(fe).some((k) => k.startsWith('profile')) ? 0 : 1); }
                    return;
                  }
                  const d = r.data!;
                  setDone({ companyId: d.companyId, tenantId: d.tenantId, note: createdNote(d), url: d.ownerInviteUrl });
                })}>Create company</Button>
              </div>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-[11.5px] text-fg-subtle">{label}</dt><dd className="mt-0.5">{children}</dd></div>;
}
