'use client';
import { Alert, Button, Field, Input } from '@crew/ui';
import { Building2, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { loginAction, selectTenantAction, ssoStartAction, verifyMfaAction } from '../actions';

type Step = { kind: 'password' } | { kind: 'sso'; email: string; notice?: string } | { kind: 'mfa'; mfaToken: string } | { kind: 'tenant'; selectToken: string; tenants: { id: string; name: string; slug: string }[] };

export function LoginForm({ next, expired, workspace, ssoFailure }: { next: string; expired: boolean; workspace?: string; ssoFailure?: string | null }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(ssoFailure ? { kind: 'sso', email: '' } : { kind: 'password' });
  const [error, setError] = useState<string | null>(ssoFailure ?? null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const [lastEmail, setLastEmail] = useState('');

  const handle = (r: Awaited<ReturnType<typeof loginAction>>) => {
    if (!r.ok) {
      // The workspace signs its members in through its identity provider: offer that instead of the password.
      if (r.code === 'sso_required') {
        setStep({ kind: 'sso', email: lastEmail, notice: r.message });
        return;
      }
      setError(r.message);
      setFieldErrors(r.fieldErrors ?? {});
      return;
    }
    const d = r.data!;
    if (d.status === 'ok') router.replace(next);
    else if (d.status === 'mfa_required') setStep({ kind: 'mfa', mfaToken: d.mfaToken });
    else setStep({ kind: 'tenant', selectToken: d.selectToken, tenants: d.tenants });
  };

  const submit = (fn: () => Promise<Awaited<ReturnType<typeof loginAction>>>) => {
    setError(null);
    setFieldErrors({});
    start(async () => handle(await fn()));
  };

  if (step.kind === 'sso') {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const email = String(new FormData(e.currentTarget).get('email') ?? '');
          setError(null);
          start(async () => {
            const r = await ssoStartAction(email);
            if (!r.ok) setError(r.code === 'not_found' ? 'Single sign-on is not set up for that email domain. Sign in with your password, or check the address.' : r.message);
            else window.location.assign(r.data!.authorizationUrl);
          });
        }}
        className="flex flex-col gap-5"
      >
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Sign in with single sign-on</h2>
          <p className="mt-1 text-sm text-fg-muted">Enter your work email. CREW sends you to your company's sign-in page and brings you back.</p>
        </div>
        {step.notice && !error && <Alert tone="info">{step.notice}</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Work email" required>
          {(p) => <Input {...p} name="email" type="email" autoComplete="username" defaultValue={step.email} required autoFocus />}
        </Field>
        <Button type="submit" size="lg" loading={pending}>Continue</Button>
        <button type="button" className="text-[13px] text-fg-muted hover:text-fg" onClick={() => { setError(null); setStep({ kind: 'password' }); }}>Use a password instead</button>
      </form>
    );
  }

  if (step.kind === 'mfa') {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const code = String(new FormData(e.currentTarget).get('code') ?? '');
          submit(() => verifyMfaAction({ mfaToken: step.mfaToken, code }));
        }}
        className="flex flex-col gap-5"
      >
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Two-step verification</h2>
          <p className="mt-1 text-sm text-fg-muted">Enter the 6-digit code from your authenticator app.</p>
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Authentication code" required>
          {(p) => <Input {...p} name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} autoFocus className="text-center text-lg tracking-[0.5em] tabular h-11" />}
        </Field>
        <Button type="submit" size="lg" loading={pending}>Verify</Button>
        <button type="button" className="text-[13px] text-fg-muted hover:text-fg" onClick={() => setStep({ kind: 'password' })}>Use a different account</button>
      </form>
    );
  }

  if (step.kind === 'tenant') {
    return (
      <div className="flex flex-col gap-5">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Choose a workspace</h2>
          <p className="mt-1 text-sm text-fg-muted">Your account belongs to more than one company.</p>
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        <ul className="flex flex-col gap-2">
          {step.tenants.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                disabled={pending}
                onClick={() => submit(() => selectTenantAction({ selectToken: step.selectToken, tenantId: t.id }))}
                className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface p-3 text-left shadow-card transition hover:border-accent hover:bg-accent-subtle/40 disabled:opacity-60"
              >
                <span className="flex size-9 items-center justify-center rounded-md bg-accent-subtle text-accent"><Building2 className="size-4" /></span>
                <span className="flex-1">
                  <span className="block font-medium">{t.name}</span>
                  <span className="block text-xs text-fg-subtle">{t.slug}</span>
                </span>
                <ChevronRight className="size-4 text-fg-subtle" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setLastEmail(String(f.get('email')));
        submit(() => loginAction({ email: String(f.get('email')), password: String(f.get('password')), tenantSlug: String(f.get('tenantSlug') ?? '') }));
      }}
      className="flex flex-col gap-5"
    >
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Sign in to CREW</h2>
        <p className="mt-1 text-sm text-fg-muted">Welcome back. Use your work email.</p>
      </div>
      {expired && !error && <Alert tone="warning">Your session ended. Sign in again to continue.</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Work email" error={fieldErrors.email} required>
        {(p) => <Input {...p} name="email" type="email" autoComplete="username" required autoFocus />}
      </Field>
      <Field label="Password" error={fieldErrors.password} required>
        {(p) => <Input {...p} name="password" type="password" autoComplete="current-password" required />}
      </Field>
      {workspace && <input type="hidden" name="tenantSlug" value={workspace} />}
      <Button type="submit" size="lg" loading={pending}>Sign in</Button>
      <Button type="button" variant="secondary" size="lg" disabled={pending} onClick={() => { setError(null); setStep({ kind: 'sso', email: '' }); }}>Sign in with single sign-on</Button>
      <p className="text-center text-[13px] text-fg-muted">
        New to CREW? <Link href="/signup" className="font-medium text-accent hover:underline">Create a workspace</Link>
      </p>
    </form>
  );
}
