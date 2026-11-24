'use client';
import { Alert, Button, Field, Input, PasswordInput } from '@crew/ui';
import { useState, useTransition } from 'react';
import { acceptInviteAction } from '../actions';

export function AcceptForm({ token, invite }: { token: string; invite: { email: string; tenantName: string; fullName: string; existingAccount: boolean } }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        start(async () => {
          const r = await acceptInviteAction({ token, fullName: String(f.get('fullName')), password: String(f.get('password')) });
          if (r && !r.ok) {
            setError(r.message);
            setFe(r.fieldErrors ?? {});
          }
        });
      }}
    >
      <div className="mb-1">
        <h2 className="text-2xl font-semibold tracking-tight">Join {invite.tenantName}</h2>
        <p className="mt-1 text-sm text-fg-muted">You were invited as <span className="font-medium text-fg">{invite.email}</span>.</p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Full name" error={fe.fullName} required>{(p) => <Input {...p} name="fullName" defaultValue={invite.fullName} required />}</Field>
      <Field
        label={invite.existingAccount ? 'Your existing SampCrew password' : 'Choose a password'}
        hint={invite.existingAccount ? 'You already have a SampCrew account; confirm it to join this workspace.' : 'At least 12 characters, mixing letters, numbers and symbols'}
        error={fe.password}
        required
      >
        {(p) => <PasswordInput {...p} name="password" autoComplete={invite.existingAccount ? 'current-password' : 'new-password'} required />}
      </Field>
      {invite.existingAccount && (
        <div className="-mt-3 text-right">
          <a href="/forgot-password" className="text-[0.8125rem] font-medium text-accent hover:underline" data-testid="forgot-password-link">Forgot password?</a>
        </div>
      )}
      <Button type="submit" size="lg" loading={pending}>Accept invitation</Button>
    </form>
  );
}
