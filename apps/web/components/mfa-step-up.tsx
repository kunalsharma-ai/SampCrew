'use client';
import { Alert, Button, Dialog, Field, Input } from '@crew/ui';
import { KeyRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ActionResult } from '@/lib/api';
import { mfaEnableAction, mfaSetupAction, mfaStepUpAction } from '@/app/(app)/settings/actions';
import { DELETE_PASSWORD_REQUIRED } from '@crew/contracts';
import { DeletePasswordContext } from './delete-guard';

/**
 * Some actions (billing, payroll settings, roles, sensitive records) need a session verified with an authenticator
 * code. A session is not verified when the person never turned two-step verification on, or signed in without a
 * code (single sign-on, an invitation link). Instead of a dead-end error, this asks for the code right there, or
 * walks through turning it on, and then the action is tried again.
 */
export function MfaVerifyForm({ mfaEnabled, onVerified, compact }: { mfaEnabled: boolean; onVerified: () => void; compact?: boolean }) {
  // Plain state, not a transition: this form usually opens while the action that asked for MFA is still pending
  // in its own transition, and React would keep both "pending" (the buttons disabled) until that one finished.
  const [pending, setPending] = useState(false);
  const start = (fn: () => Promise<void>) => {
    setPending(true);
    fn().finally(() => setPending(false));
  };
  const [enabled, setEnabled] = useState(mfaEnabled);
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = (code: string) =>
    start(async () => {
      setError(null);
      const r = enabled ? await mfaStepUpAction(code) : await mfaEnableAction(code);
      if (r.ok) {
        setEnabled(true);
        onVerified();
      } else if (r.code === 'mfa_not_enabled') {
        setEnabled(false);
        setError('Two-step verification is not on for your account yet. Set it up below.');
      } else setError(r.message);
    });

  const codeForm = (label: string, button: string) => (
    <form
      className="flex flex-col gap-3"
      data-testid="mfa-step-up-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit(String(new FormData(e.currentTarget).get('code') ?? '').trim());
      }}
    >
      <Field label={label} required>
        {(p) => <Input {...p} name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" autoFocus required className="tabular tracking-[0.3em]" data-testid="mfa-step-up-code" />}
      </Field>
      <Button type="submit" loading={pending} data-testid="mfa-step-up-submit">{button}</Button>
    </form>
  );

  return (
    <div className="flex flex-col gap-4">
      {error && <Alert tone="danger">{error}</Alert>}
      {enabled ? (
        <>
          {!compact && <p className="text-[0.8125rem] text-fg-muted">Open your authenticator app and enter the 6-digit code for SampCrew. You stay signed in.</p>}
          {codeForm('Code from your authenticator app', 'Verify and continue')}
        </>
      ) : setup ? (
        <>
          <ol className="list-decimal space-y-1 pl-5 text-[0.8125rem] text-fg-muted">
            <li>Scan this QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy).</li>
            <li>Enter the 6-digit code it shows. From now on, sign-in asks for a code too.</li>
          </ol>
          <div className="flex items-center gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={setup.qr} alt="QR code for your authenticator app" className="size-36 rounded-md border border-border bg-white p-1" />
            <div className="min-w-0 text-xs text-fg-subtle">
              Can&apos;t scan? Enter this key manually:
              <code className="mt-1 block break-all rounded bg-bg-subtle px-2 py-1 font-mono text-[0.6875rem] text-fg" data-testid="mfa-step-up-secret">{setup.secret}</code>
            </div>
          </div>
          {codeForm('Code from your app', 'Turn on and continue')}
        </>
      ) : (
        <>
          <p className="text-[0.8125rem] text-fg-muted">This action needs two-step verification, and it is not on for your account yet. It takes a minute with an authenticator app on your phone.</p>
          <Button
            loading={pending}
            data-testid="mfa-step-up-setup"
            onClick={() =>
              start(async () => {
                setError(null);
                const r = await mfaSetupAction();
                if (r.ok) setSetup(r.data!);
                else if (r.code === 'mfa_already_enabled') setEnabled(true);
                else setError(r.message);
              })
            }
          >
            <KeyRound className="size-4" /> Set up two-step verification
          </Button>
        </>
      )}
    </div>
  );
}

type Ask = () => Promise<boolean>;
const MfaContext = createContext<Ask | null>(null);

/** Holds the one verification dialog for the signed-in app. */
export function MfaStepUpProvider({ mfaEnabled, children }: { mfaEnabled: boolean; children: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const waiting = useRef<((ok: boolean) => void)[]>([]);
  const settle = (ok: boolean) => {
    const w = waiting.current;
    waiting.current = [];
    setOpen(false);
    w.forEach((r) => r(ok));
  };
  const ask = useCallback<Ask>(() => new Promise<boolean>((resolve) => {
    waiting.current.push(resolve);
    setOpen(true);
  }), []);
  return (
    <MfaContext.Provider value={ask}>
      {children}
      <Dialog open={open} onClose={() => settle(false)} title="Verify it's you" description="This action needs two-step verification." size="sm">
        <div data-testid="mfa-step-up-dialog">
          {open && <MfaVerifyForm mfaEnabled={mfaEnabled} onVerified={() => { settle(true); router.refresh(); }} />}
        </div>
      </Dialog>
    </MfaContext.Provider>
  );
}

/**
 * Returns a wrapper for server actions: when one answers "needs MFA", the verification dialog opens, and once the
 * person verifies, the same action runs again. Cancelling returns the original answer.
 */
export function useMfaRetry() {
  const ask = useContext(MfaContext);
  const askDelete = useContext(DeletePasswordContext);
  return useCallback(
    async <T extends { ok: boolean; code?: string }>(fn: () => Promise<T>): Promise<T> => {
      let r = await fn();
      if (!r.ok && r.code === 'mfa_required' && ask) r = (await ask()) ? await fn() : r;
      // A delete sent without the password (delete-guard.tsx): ask for it and send the delete again.
      if (!r.ok && r.code === DELETE_PASSWORD_REQUIRED && askDelete) r = (await askDelete('this item')) ? await fn() : r;
      return r;
    },
    [ask, askDelete],
  );
}
