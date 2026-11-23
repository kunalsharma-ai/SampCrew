'use client';
import { DELETE_PASSWORD_REQUIRED } from '@crew/contracts';
import { Trash2 } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Button } from './button';
import { Dialog } from './dialog';
import { Field, Input } from './form';
import { Alert } from './surface';

/** Checks the person's password on the server for one delete (a server action of the app). */
export type ConfirmDeletePassword = (password: string) => Promise<{ ok: boolean; message?: string }>;

/**
 * Password-confirmed deletion in the Web Portal and the Console (contracts delete-permissions.ts). Two ways in, both ending in the same
 * dialog that asks for the person's own password:
 *  - Delete buttons carry data-delete="what" (and data-delete-area="area", which hides them where the person may not
 *    delete). A click on one is held, the password is asked, and the click goes through once it is right.
 *  - Any action that comes back with delete_password_required (a delete started some other way) asks the same and is
 *    tried again (useDeleteRetry, also part of useMfaRetry and useRunner).
 * The server checks the password and lets the session run one delete within two minutes; it also refuses deletes
 * the level above has not allowed, so the dialog never opens up anything by itself.
 */
type Ask = (what: string) => Promise<boolean>;
export const DeletePasswordContext = createContext<Ask | null>(null);

export function DeletePasswordForm({ what, confirm, onConfirmed, onCancel }: { what: string; confirm: ConfirmDeletePassword; onConfirmed: () => void; onCancel: () => void }) {
  // Plain state, not a transition (the action asking for it is usually still pending in its own transition).
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-4"
      data-testid="delete-password-form"
      onSubmit={(e) => {
        e.preventDefault();
        const password = String(new FormData(e.currentTarget).get('password') ?? '');
        setPending(true);
        setError(null);
        void confirm(password).then((r) => {
          setPending(false);
          if (r.ok) onConfirmed();
          else setError(r.message ?? 'That did not work. Try again.');
        });
      }}
    >
      <p className="text-[0.8125rem] text-fg-muted">
        You are deleting <strong className="text-fg" data-testid="delete-password-what">{what}</strong>. Enter your own password to continue. It is checked for this one delete only.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Your password" required>
        {(p) => <Input {...p} name="password" type="password" autoComplete="current-password" autoFocus required maxLength={200} data-testid="delete-password-input" />}
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} data-testid="delete-password-cancel">Cancel</Button>
        <Button type="submit" variant="danger" loading={pending} data-testid="delete-password-submit"><Trash2 className="size-4" /> Confirm and delete</Button>
      </div>
    </form>
  );
}

export function DeletePasswordProvider({ confirm, children }: { confirm: ConfirmDeletePassword; children: React.ReactNode }) {
  const [what, setWhat] = useState<string | null>(null);
  const waiting = useRef<((ok: boolean) => void)[]>([]);
  const settle = (ok: boolean) => {
    const w = waiting.current;
    waiting.current = [];
    setWhat(null);
    w.forEach((r) => r(ok));
  };
  const ask = useCallback<Ask>((label) => new Promise<boolean>((resolve) => {
    waiting.current.push(resolve);
    setWhat(label);
  }), []);

  // Delete buttons: hold the click, ask for the password, then let the same click through.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-delete]') as HTMLElement | null;
      if (!el) return;
      if (el.dataset.deleteOk === '1') {
        delete el.dataset.deleteOk;
        return;
      }
      if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void ask(el.dataset.delete || 'this item').then((ok) => {
        if (!ok || !el.isConnected) return;
        el.dataset.deleteOk = '1';
        el.click();
      });
    };
    window.addEventListener('click', onClick, true);
    return () => window.removeEventListener('click', onClick, true);
  }, [ask]);

  return (
    <DeletePasswordContext.Provider value={ask}>
      {children}
      <Dialog open={what !== null} onClose={() => settle(false)} title="Confirm with your password" description="Every delete in SampCrew asks for your password first." size="sm">
        <div data-testid="delete-password-dialog">
          {what !== null && <DeletePasswordForm what={what} confirm={confirm} onConfirmed={() => settle(true)} onCancel={() => settle(false)} />}
        </div>
      </Dialog>
    </DeletePasswordContext.Provider>
  );
}

/**
 * Wraps a server action: when it answers delete_password_required, the password dialog opens and, once the password is
 * right, the same action runs again. Cancelling returns the original answer.
 */
export function useDeleteRetry() {
  const ask = useContext(DeletePasswordContext);
  return useCallback(
    async <T extends { ok: boolean; code?: string; message?: string }>(fn: () => Promise<T>, what = 'this item'): Promise<T> => {
      const r = await fn();
      if (r.ok || r.code !== DELETE_PASSWORD_REQUIRED || !ask) return r;
      return (await ask(what)) ? fn() : r;
    },
    [ask],
  );
}
