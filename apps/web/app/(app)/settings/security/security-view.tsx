'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Field, Input } from '@crew/ui';
import { Laptop, ShieldCheck, Smartphone } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { changePasswordAction, mfaEnableAction, mfaSetupAction, revokeSessionAction } from '../actions';

export function SecurityView({ mfaEnabled, sessionMfa, sessions }: { mfaEnabled: boolean; sessionMfa: boolean; sessions: { id: string; client: string; ip: string | null; userAgent: string | null; createdAt: string; current: boolean }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pwMsg, setPwMsg] = useState<{ tone: 'success' | 'danger'; text: string; fe?: Record<string, string> } | null>(null);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader title="Two-step verification" description="Use an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy)." action={mfaEnabled ? <Badge tone="success" dot>On</Badge> : <Badge tone="warning" dot>Off</Badge>} />
        <CardBody className="flex flex-col gap-4">
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
          {mfaEnabled ? (
            <div className="flex items-start gap-3 rounded-md bg-success-subtle p-3 text-[13px] text-success">
              <ShieldCheck className="size-5 shrink-0" />
              <div>Your account asks for a code at every sign-in.{sessionMfa ? ' This session is verified, so admin actions that need MFA are unlocked.' : ''}</div>
            </div>
          ) : setup ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                const code = String(new FormData(e.currentTarget).get('code'));
                start(async () => {
                  const r = await mfaEnableAction(code);
                  if (r.ok) {
                    setSetup(null);
                    setMsg({ tone: 'success', text: 'Two-step verification is on.' });
                    router.refresh();
                  } else setMsg({ tone: 'danger', text: r.message });
                });
              }}
            >
              <ol className="list-decimal space-y-1 pl-5 text-[13px] text-fg-muted">
                <li>Scan this QR code with your authenticator app.</li>
                <li>Enter the 6-digit code it shows.</li>
              </ol>
              <div className="flex items-center gap-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={setup.qr} alt="QR code for your authenticator app" className="size-40 rounded-md border border-border bg-white p-1" />
                <div className="min-w-0 text-xs text-fg-subtle">
                  Can&apos;t scan? Enter this key manually:
                  <code className="mt-1 block break-all rounded bg-bg-subtle px-2 py-1 font-mono text-[11px] text-fg">{setup.secret}</code>
                </div>
              </div>
              <Field label="Code from your app" required>
                {(p) => <Input {...p} name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" required className="tabular tracking-[0.3em]" />}
              </Field>
              <Button type="submit" loading={pending}>Turn on</Button>
            </form>
          ) : (
            <Button
              loading={pending}
              onClick={() =>
                start(async () => {
                  const r = await mfaSetupAction();
                  if (r.ok) setSetup(r.data!);
                  else setMsg({ tone: 'danger', text: r.message });
                })
              }
            >
              Set up two-step verification
            </Button>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Password" description="Changing it signs you out on every other device." />
        <CardBody>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const f = new FormData(form);
              if (f.get('newPassword') !== f.get('confirm')) return setPwMsg({ tone: 'danger', text: 'The new passwords do not match.' });
              start(async () => {
                const r = await changePasswordAction(String(f.get('currentPassword')), String(f.get('newPassword')));
                setPwMsg(r.ok ? { tone: 'success', text: r.message! } : { tone: 'danger', text: r.message, fe: r.fieldErrors });
                if (r.ok) form.reset();
              });
            }}
          >
            {pwMsg && <Alert tone={pwMsg.tone}>{pwMsg.text}</Alert>}
            <Field label="Current password" required>{(p) => <Input {...p} name="currentPassword" type="password" autoComplete="current-password" required />}</Field>
            <Field label="New password" hint="At least 12 characters, mixing letters, numbers and symbols" error={pwMsg?.fe?.newPassword} required>{(p) => <Input {...p} name="newPassword" type="password" autoComplete="new-password" required minLength={12} />}</Field>
            <Field label="Confirm new password" required>{(p) => <Input {...p} name="confirm" type="password" autoComplete="new-password" required />}</Field>
            <Button type="submit" variant="secondary" loading={pending}>Change password</Button>
          </form>
        </CardBody>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader title="Where you're signed in" description="Sessions in this workspace. Sign out any you don't recognise." />
        <ul className="divide-y divide-border border-t border-border">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-5 py-3">
              {s.client === 'mobile' ? <Smartphone className="size-4 text-fg-subtle" /> : <Laptop className="size-4 text-fg-subtle" />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px]">{s.userAgent?.slice(0, 90) ?? 'Unknown device'}</div>
                <div className="text-xs text-fg-subtle">{s.ip ?? 'Unknown IP'} · since {new Date(s.createdAt).toLocaleString()}</div>
              </div>
              {s.current ? <Badge tone="accent">This device</Badge> : <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => void (await revokeSessionAction(s.id)))}>Sign out</Button>}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
