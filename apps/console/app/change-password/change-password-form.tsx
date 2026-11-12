'use client';
import { password as passwordSchema } from '@crew/contracts';
import { Alert, Button, Field, Input } from '@crew/ui';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { z } from 'zod';
import { changePasswordAction, logoutAction } from '../auth-actions';

const schema = z
  .object({ currentPassword: z.string().min(1, 'Required'), newPassword: passwordSchema, confirm: z.string() })
  .refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'The two passwords are not the same' });

export function ChangePasswordForm({ email, required }: { email: string; required: boolean }) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = schema.safeParse(Object.fromEntries(new FormData(e.currentTarget)));
        if (!parsed.success) {
          setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])));
          return;
        }
        setErrors({});
        setError(null);
        start(async () => {
          const r = await changePasswordAction({ currentPassword: parsed.data.currentPassword, newPassword: parsed.data.newPassword });
          if (r && !r.ok) {
            setError(r.message);
            setErrors(r.fieldErrors ?? {});
          }
        });
      }}
    >
      <div>
        <h1 className="text-lg font-semibold">{required ? 'Choose your own password' : 'Change your password'}</h1>
        <p className="text-sm text-fg-muted">
          {required
            ? `The password for ${email} was set by another admin. Choose one only you know before you continue.`
            : `For ${email}. Your other console sessions are signed out.`}
        </p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label={required ? 'Temporary password' : 'Current password'} error={errors.currentPassword} required>
        {(p) => <Input {...p} name="currentPassword" type="password" autoComplete="current-password" />}
      </Field>
      <Field label="New password" hint="At least 12 characters, with three of: lowercase, uppercase, numbers, symbols" error={errors.newPassword} required>
        {(p) => <Input {...p} name="newPassword" type="password" autoComplete="new-password" />}
      </Field>
      <Field label="New password again" error={errors.confirm} required>
        {(p) => <Input {...p} name="confirm" type="password" autoComplete="new-password" />}
      </Field>
      <Button type="submit" loading={pending}>Save new password</Button>
      {required ? (
        <Button type="button" variant="ghost" onClick={() => start(() => logoutAction())}>Sign out</Button>
      ) : (
        <Link href="/" className="text-center text-sm text-fg-muted hover:text-fg">Cancel</Link>
      )}
    </form>
  );
}
