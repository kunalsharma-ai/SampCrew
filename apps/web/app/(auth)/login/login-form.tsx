'use client';
import { Alert, Button, EmailInput, Field, Input, PasswordInput, emailProblem, markWelcomeIntro, useSignInStatus } from '@crew/ui';
import { Building2, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { initialPasswordAction, loginAction, selectTenantAction, ssoStartAction, verifyMfaAction } from '../actions';

type Step = { kind: 'password' } | { kind: 'sso'; email: string; notice?: string } | { kind: 'mfa'; mfaToken: string } | { kind: 'newPassword'; changeToken: string } | { kind: 'tenant'; selectToken: string; tenants: { id: string; name: string; slug: string }[] };

export function LoginForm({ title = 'Sign in to SampCrew', next, expired, workspace, ssoFailure, notice, addressProblem }: { title?: string; next: string; expired: boolean; workspace?: string; ssoFailure?: string | null; notice?: string | null; addressProblem?: string | null }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(ssoFailure ? { kind: 'sso', email: '' } : { kind: 'password' });
  const [error, setError] = useState<string | null>(ssoFailure ?? null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  // A ref, not state: the answer is handled by the closure from the render that sent it, which a state update made
  // in the same submit would not reach, so the single sign-on step would open with an empty email.
  const lastEmail = useRef('');
  // The tick or cross in the boxes and the card's animation: right password, wrong password, signed in.
  const feedback = useSignInStatus();
  const [verdict, setVerdict] = useState<'ok' | 'bad' | null>(null);
  const settle = (fn: () => void, ms = 650) => {
    const quick = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    window.setTimeout(fn, quick ? 150 : ms);
  };

  const handle = (r: Awaited<ReturnType<typeof loginAction>>) => {
    if (!r.ok) {
      // The workspace signs its members in through its identity provider: offer that instead of the password.
      if (r.code === 'sso_required') {
        setStep({ kind: 'sso', email: lastEmail.current, notice: r.message });
        return;
      }
      setError(r.message);
      setFieldErrors(r.fieldErrors ?? {});
      if (step.kind === 'password' || step.kind === 'mfa') { setVerdict('bad'); feedback.set('fail'); } else feedback.set('idle');
      return;
    }
    const d = r.data!;
    setVerdict('ok');
    if (d.status === 'ok') {
      feedback.set('ok');
      markWelcomeIntro();
      settle(() => router.replace(next), 1250);
      return;
    }
    feedback.set('idle');
    // The password was right: let the ticks show for a moment before the next step.
    settle(() => {
      setVerdict(null);
      if (d.status === 'mfa_required') setStep({ kind: 'mfa', mfaToken: d.mfaToken });
      else if (d.status === 'password_change_required') setStep({ kind: 'newPassword', changeToken: d.changeToken });
      else setStep({ kind: 'tenant', selectToken: d.selectToken, tenants: d.tenants });
    }, step.kind === 'password' ? 650 : 0);
  };

  const submit = (fn: () => Promise<Awaited<ReturnType<typeof loginAction>>>) => {
    setError(null);
    setFieldErrors({});
    setVerdict(null);
    feedback.set('checking');
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
          <p className="mt-1 text-sm text-fg-muted">Enter your work email. SampCrew sends you to your company's sign-in page and brings you back.</p>
        </div>
        {step.notice && !error && <Alert tone="info">{step.notice}</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Work email" required>
          {(p) => <EmailInput {...p} name="email" autoComplete="username" defaultValue={step.email} required autoFocus />}
        </Field>
        <Button type="submit" size="lg" loading={pending}>Continue</Button>
        <button type="button" className="text-[0.8125rem] text-fg-muted hover:text-fg" onClick={() => { setError(null); setStep({ kind: 'password' }); }}>Use a password instead</button>
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
        <button type="button" className="text-[0.8125rem] text-fg-muted hover:text-fg" onClick={() => setStep({ kind: 'password' })}>Use a different account</button>
      </form>
    );
  }

  if (step.kind === 'newPassword') {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const newPassword = String(f.get('newPassword') ?? '');
          if (newPassword !== String(f.get('confirmPassword') ?? '')) { setError(null); setFieldErrors({ confirmPassword: 'The two passwords do not match' }); return; }
          submit(() => initialPasswordAction({ changeToken: step.changeToken, newPassword }));
        }}
        className="flex flex-col gap-5"
      >
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Choose your password</h2>
          <p className="mt-1 text-sm text-fg-muted">You signed in with a temporary password from HR. Choose your own to carry on; the temporary one stops working.</p>
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="New password" error={fieldErrors.newPassword} hint="12+ characters with three of: lowercase, uppercase, numbers, symbols" required>
          {(p) => <PasswordInput {...p} name="newPassword" autoComplete="new-password" required autoFocus rules />}
        </Field>
        <Field label="Confirm new password" error={fieldErrors.confirmPassword} required>
          {(p) => <PasswordInput {...p} name="confirmPassword" autoComplete="new-password" required matches="newPassword" />}
        </Field>
        <Button type="submit" size="lg" loading={pending}>Save password and sign in</Button>
        <button type="button" className="text-[0.8125rem] text-fg-muted hover:text-fg" onClick={() => setStep({ kind: 'password' })}>Use a different account</button>
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
        lastEmail.current = String(f.get('email'));
        const bad = emailProblem(lastEmail.current);
        if (bad) { setFieldErrors({ email: bad }); setVerdict(null); feedback.set('fail'); return; }
        if (!String(f.get('password') ?? '')) { setFieldErrors({ password: 'Enter your password' }); feedback.set('fail'); return; }
        submit(() => loginAction({ email: String(f.get('email')), password: String(f.get('password')), tenantSlug: String(f.get('tenantSlug') ?? '') }));
      }}
      className="flex flex-col gap-5"
    >
      <div>
        <h2 className="text-2xl font-semibold tracking-tight" data-testid="login-title">{title}</h2>
        <p className="mt-1 text-sm text-fg-muted">Welcome back. Use your work email.</p>
      </div>
      {addressProblem && !error && <Alert tone="danger">{addressProblem}</Alert>}
      {expired && !notice && !error && <Alert tone="warning">Your session ended. Sign in again to continue.</Alert>}
      {notice && !error && <Alert tone="warning">{notice}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Work email" error={fieldErrors.email} required>
        {(p) => <EmailInput {...p} name="email" autoComplete="username" required autoFocus verified={verdict === 'ok'} onChange={() => { if (fieldErrors.email) setFieldErrors(({ email: _e, ...rest }) => rest); }} />}
      </Field>
      <Field label="Password" error={fieldErrors.password} required>
        {(p) => <PasswordInput {...p} name="password" autoComplete="current-password" required check={verdict} onChange={() => { if (verdict === 'bad') { setVerdict(null); feedback.set('idle'); } }} />}
      </Field>
      <div className="-mt-3 text-right">
        <Link href="/forgot-password" className="text-[0.8125rem] font-medium text-accent hover:underline" data-testid="forgot-password-link">Forgot password?</Link>
      </div>
      {workspace && <input type="hidden" name="tenantSlug" value={workspace} />}
      <Button type="submit" size="lg" loading={pending}>Sign in</Button>
      <Button type="button" variant="secondary" size="lg" disabled={pending} onClick={() => { setError(null); setStep({ kind: 'sso', email: '' }); }}>Sign in with single sign-on</Button>
      <p className="text-center text-[0.8125rem] text-fg-muted">
        New to SampCrew? <Link href="/signup" className="font-medium text-accent hover:underline">Create a workspace</Link>
      </p>
    </form>
  );
}
