'use client';
import { CheckCircle2, MailCheck } from 'lucide-react';
import { useState, useTransition } from 'react';
import { Button, buttonClass } from './button';
import { Field, Input } from './form';
import { Alert } from './surface';

/** What a server action returns to these forms (the shape of ActionResult in the web and console apps). */
export type ResetActionResult = { ok: true; data?: { message?: string } } | { ok: false; message: string; code?: string; fieldErrors?: Record<string, string> };

const PASSWORD_HINT = '12+ characters with three of: lowercase, uppercase, numbers, symbols';

/**
 * "Forgot password?": the person types their email and gets a link and a 6-digit code. The answer never says whether
 * an account exists. They can then follow the link, or enter the code here with a new password.
 */
export function ForgotPasswordForm({
  request,
  complete,
  signInHref,
  heading = 'Forgot your password?',
  intro = 'Enter the email you sign in with. We email you a link and a 6-digit code to choose a new password.',
}: {
  request: (email: string) => Promise<ResetActionResult>;
  complete: (input: { email: string; code: string; newPassword: string }) => Promise<ResetActionResult>;
  signInHref: string;
  heading?: string;
  intro?: string;
}) {
  const [step, setStep] = useState<'email' | 'sent' | 'code' | 'done'>('email');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<ResetActionResult>, next: (r: Extract<ResetActionResult, { ok: true }>) => void) => {
    setError(null);
    setFieldErrors({});
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        setError(r.code === 'rate_limited' ? 'Too many attempts. Wait a minute and try again.' : r.message);
        setFieldErrors(r.fieldErrors ?? {});
        return;
      }
      next(r);
    });
  };

  if (step === 'done') return <ResetDone signInHref={signInHref} message={message} />;

  if (step === 'email') {
    return (
      <form
        className="flex flex-col gap-5"
        data-testid="forgot-form"
        onSubmit={(e) => {
          e.preventDefault();
          const value = String(new FormData(e.currentTarget).get('email') ?? '').trim();
          setEmail(value);
          run(() => request(value), (r) => { setMessage(r.data?.message ?? null); setStep('sent'); });
        }}
      >
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{heading}</h2>
          <p className="mt-1 text-sm text-fg-muted">{intro}</p>
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Email" error={fieldErrors.email} required>
          {(p) => <Input {...p} name="email" type="email" autoComplete="username" defaultValue={email} required autoFocus />}
        </Field>
        <Button type="submit" size="lg" loading={pending}>Send reset link</Button>
        <a href={signInHref} className="text-center text-[0.8125rem] text-fg-muted hover:text-fg">Back to sign in</a>
      </form>
    );
  }

  if (step === 'sent') {
    return (
      <div className="flex flex-col gap-5" data-testid="forgot-sent">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-accent"><MailCheck className="size-5" /></span>
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Check your email</h2>
            <p className="mt-1 text-sm text-fg-muted">{message}</p>
          </div>
        </div>
        <Button type="button" size="lg" variant="secondary" onClick={() => setStep('code')}>I have a 6-digit code</Button>
        <button type="button" className="text-[0.8125rem] text-fg-muted hover:text-fg" onClick={() => run(() => request(email), (r) => setMessage(r.data?.message ?? null))} disabled={pending}>
          Send it again
        </button>
        <a href={signInHref} className="text-center text-[0.8125rem] text-fg-muted hover:text-fg">Back to sign in</a>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-5"
      data-testid="forgot-code-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const newPassword = String(f.get('newPassword') ?? '');
        if (newPassword !== String(f.get('confirmPassword') ?? '')) return setFieldErrors({ confirmPassword: 'The two passwords do not match' });
        const value = String(f.get('email') ?? '').trim();
        run(() => complete({ email: value, code: String(f.get('code') ?? ''), newPassword }), (r) => { setMessage(r.data?.message ?? null); setStep('done'); });
      }}
    >
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Enter your code</h2>
        <p className="mt-1 text-sm text-fg-muted">Type the 6-digit code from the email and choose a new password.</p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Email" error={fieldErrors.email} required>
        {(p) => <Input {...p} name="email" type="email" autoComplete="username" defaultValue={email} required />}
      </Field>
      <Field label="6-digit code" error={fieldErrors.code} required>
        {(p) => <Input {...p} name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus className="h-11 text-center text-lg tracking-[0.5em] tabular" />}
      </Field>
      <PasswordFields errors={fieldErrors} />
      <Button type="submit" size="lg" loading={pending}>Save new password</Button>
      <button type="button" className="text-[0.8125rem] text-fg-muted hover:text-fg" onClick={() => setStep('email')}>Ask for a new code</button>
    </form>
  );
}

/** The page the emailed link opens: choose a new password (the link works once, for 30 minutes). */
export function ResetPasswordForm({
  token,
  maskedEmail,
  complete,
  signInHref,
}: {
  token: string;
  maskedEmail?: string;
  complete: (input: { token: string; newPassword: string }) => Promise<ResetActionResult>;
  signInHref: string;
}) {
  const [done, setDone] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  if (done !== undefined) return <ResetDone signInHref={signInHref} message={done} />;
  return (
    <form
      className="flex flex-col gap-5"
      data-testid="reset-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const newPassword = String(f.get('newPassword') ?? '');
        setError(null);
        if (newPassword !== String(f.get('confirmPassword') ?? '')) return setFieldErrors({ confirmPassword: 'The two passwords do not match' });
        setFieldErrors({});
        start(async () => {
          const r = await complete({ token, newPassword });
          if (!r.ok) {
            setError(r.message);
            setFieldErrors(r.fieldErrors ?? {});
          } else setDone(r.data?.message ?? null);
        });
      }}
    >
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Choose a new password</h2>
        <p className="mt-1 text-sm text-fg-muted">{maskedEmail ? `For ${maskedEmail}. ` : ''}Setting it signs you out on every device.</p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <PasswordFields errors={fieldErrors} autoFocus />
      <Button type="submit" size="lg" loading={pending}>Save new password</Button>
      <a href={signInHref} className="text-center text-[0.8125rem] text-fg-muted hover:text-fg">Back to sign in</a>
    </form>
  );
}

function PasswordFields({ errors, autoFocus }: { errors: Record<string, string>; autoFocus?: boolean }) {
  return (
    <>
      <Field label="New password" error={errors.newPassword} hint={PASSWORD_HINT} required>
        {(p) => <Input {...p} name="newPassword" type="password" autoComplete="new-password" required autoFocus={autoFocus} />}
      </Field>
      <Field label="Confirm new password" error={errors.confirmPassword} required>
        {(p) => <Input {...p} name="confirmPassword" type="password" autoComplete="new-password" required />}
      </Field>
    </>
  );
}

function ResetDone({ signInHref, message }: { signInHref: string; message?: string | null }) {
  return (
    <div className="flex flex-col gap-5" data-testid="reset-done">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-success-subtle text-success"><CheckCircle2 className="size-5" /></span>
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Password changed</h2>
          <p className="mt-1 text-sm text-fg-muted">{message ?? 'Sign in with your new password.'}</p>
        </div>
      </div>
      <a href={signInHref} className={buttonClass('primary', 'lg')} data-testid="reset-sign-in">Sign in</a>
    </div>
  );
}
