'use client';
import { Alert, Button, Field, Input } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { firstAdminAction } from '../auth-actions';

/**
 * Creates the first Super admin. The setup code is printed in the API's log ("SampCrew is not set up yet"), so only
 * whoever runs the server can finish this; two-step verification is set up straight after.
 */
export function SetupForm({ addressProblem }: { addressProblem?: string | null }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const input = {
          setupCode: String(f.get('setupCode') ?? ''), fullName: String(f.get('fullName') ?? ''), email: String(f.get('email') ?? ''),
          password: String(f.get('password') ?? ''),
        };
        if (input.password !== String(f.get('confirm') ?? '')) {
          setFieldErrors({ confirm: 'The two passwords are not the same' });
          return;
        }
        setError(null);
        setFieldErrors({});
        start(async () => {
          const r = await firstAdminAction(input);
          if (!r.ok) {
            setError(r.message);
            setFieldErrors(r.fieldErrors ?? {});
            return;
          }
          router.replace(r.data!.step === 'enrol' ? '/enrol' : '/');
        });
      }}
    >
      <div>
        <h1 className="text-lg font-semibold">Set up SampCrew</h1>
        <p className="text-sm text-fg-muted">Create the first Super admin. Afterwards you add email, AI, payments and every other key in Integrations; nothing goes in the server&apos;s settings file.</p>
      </div>
      {addressProblem && !error && <Alert tone="danger">{addressProblem}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Setup code" required error={fieldErrors.setupCode} hint='Printed in the API log on the line "SampCrew is not set up yet", e.g. docker compose logs api.'>
        {(p) => <Input {...p} name="setupCode" autoComplete="off" spellCheck={false} placeholder="XXXXX-XXXXX-XXXXX" required autoFocus className="tracking-widest" data-testid="setup-code" />}
      </Field>
      <Field label="Your name" required error={fieldErrors.fullName}>{(p) => <Input {...p} name="fullName" autoComplete="name" required />}</Field>
      <Field label="Email" required error={fieldErrors.email}>{(p) => <Input {...p} name="email" type="email" autoComplete="username" required />}</Field>
      <Field label="Password" required error={fieldErrors.password} hint="At least 12 characters, with three of: lower case, upper case, numbers, symbols.">
        {(p) => <Input {...p} name="password" type="password" autoComplete="new-password" required />}
      </Field>
      <Field label="Password again" required error={fieldErrors.confirm}>{(p) => <Input {...p} name="confirm" type="password" autoComplete="new-password" required />}</Field>
      <Button type="submit" loading={pending}>Create Super admin</Button>
      <p className="text-xs text-fg-subtle">Next you set up two-step verification with an authenticator app. It is required for every Console admin.</p>
    </form>
  );
}
