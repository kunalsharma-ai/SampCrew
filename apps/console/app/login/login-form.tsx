'use client';
import { Alert, Button, Field, Input } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { loginAction } from '../auth-actions';

export function LoginForm({ next, expired }: { next: string; expired: boolean }) {
  const router = useRouter();
  const [creds, setCreds] = useState<{ email: string; password: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (input: { email: string; password: string; code?: string }) => {
    setError(null);
    start(async () => {
      const r = await loginAction(input);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      if (r.data!.step === 'mfa') setCreds({ email: input.email, password: input.password });
      else router.replace(r.data!.step === 'enrol' ? '/enrol' : next);
    });
  };

  if (creds) {
    return (
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          run({ ...creds, code: String(new FormData(e.currentTarget).get('code') ?? '') });
        }}
      >
        <div>
          <h1 className="text-lg font-semibold">Two-step verification</h1>
          <p className="text-sm text-fg-muted">Enter the code from your authenticator app.</p>
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Authentication code" required>
          {(p) => <Input {...p} name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus className="h-11 text-center text-lg tracking-[0.5em] tabular" />}
        </Field>
        <Button type="submit" loading={pending}>Verify</Button>
        <button type="button" className="text-[13px] text-fg-muted hover:text-fg" onClick={() => setCreds(null)}>Use a different account</button>
      </form>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        run({ email: String(f.get('email') ?? ''), password: String(f.get('password') ?? '') });
      }}
    >
      <h1 className="text-lg font-semibold">Sign in to the console</h1>
      {expired && !error && <Alert tone="warning">Your session ended. Sign in again.</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Email" required>{(p) => <Input {...p} name="email" type="email" autoComplete="username" required autoFocus />}</Field>
      <Field label="Password" required>{(p) => <Input {...p} name="password" type="password" autoComplete="current-password" required />}</Field>
      <Button type="submit" loading={pending}>Sign in</Button>
    </form>
  );
}
