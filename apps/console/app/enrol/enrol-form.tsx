'use client';
import { Alert, Button, Field, Input } from '@crew/ui';
import { useState, useTransition } from 'react';
import { logoutAction, mfaEnableAction, mfaSetupAction } from '../auth-actions';

export function EnrolForm({ email, enrolled }: { email: string; enrolled: boolean }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (enrolled) {
    // Enrolled admins reach this page only with a session that was not MFA-verified; they must sign in again with a code.
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-lg font-semibold">Verification needed</h1>
        <p className="text-sm text-fg-muted">Sign in again and enter your authenticator code to continue.</p>
        <Button onClick={() => start(() => logoutAction())} loading={pending}>Sign in again</Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Set up two-step verification</h1>
        <p className="text-sm text-fg-muted">Console access requires an authenticator app for {email}. This is not optional.</p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {!setup ? (
        <Button loading={pending} onClick={() => start(async () => {
          const r = await mfaSetupAction();
          if (r.ok) setSetup(r.data!);
          else setError(r.message);
        })}>Show QR code</Button>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const code = String(new FormData(e.currentTarget).get('code') ?? '');
            setError(null);
            start(async () => {
              const r = await mfaEnableAction(code);
              if (r && !r.ok) setError(r.message);
            });
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={setup.qr} alt="QR code for your authenticator app" width={200} height={200} className="mx-auto rounded-md border border-border bg-white" />
          <p className="text-xs text-fg-muted">Cannot scan? Enter this key manually:<code className="mt-1 block break-all rounded bg-bg-subtle px-2 py-1 font-mono text-[11px] text-fg">{setup.secret}</code></p>
          <Field label="6-digit code" required>{(p) => <Input {...p} name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" required className="tabular tracking-[0.3em]" />}</Field>
          <Button type="submit" loading={pending}>Turn on and continue</Button>
        </form>
      )}
    </div>
  );
}
