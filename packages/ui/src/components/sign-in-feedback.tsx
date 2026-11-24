'use client';
import { createContext, forwardRef, useContext, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../cn';
import { inputControlClass } from './form';

/**
 * Sign-in feedback for every sign-in box (Console, Super Workspace, HR Workspace, Employee Workspace):
 *
 *  - checking: the password is being checked (the card's border speeds up),
 *  - ok: the email and password were right: a green tick draws itself in each box and a success burst plays over the
 *    card while the workspace opens,
 *  - fail: they were wrong: a red cross draws in the password box and the card shakes.
 *
 * Forms report what happened with useSignInStatus(); outside a sign-in card it does nothing.
 */
export type SignInStatus = 'idle' | 'checking' | 'ok' | 'fail';

const Ctx = createContext<{ status: SignInStatus; set: (s: SignInStatus) => void; attempt: number } | null>(null);

export function SignInStatusProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ status: SignInStatus; attempt: number }>({ status: 'idle', attempt: 0 });
  const set = (status: SignInStatus) => setState((s) => ({ status, attempt: status === 'fail' ? s.attempt + 1 : s.attempt }));
  return <Ctx.Provider value={{ status: state.status, set, attempt: state.attempt }}>{children}</Ctx.Provider>;
}

/** What the form reports to the card around it. */
export function useSignInStatus() {
  const c = useContext(Ctx);
  return { status: c?.status ?? 'idle', set: c?.set ?? (() => {}), attempt: c?.attempt ?? 0 };
}

export type CheckState = 'ok' | 'bad' | null;

/** An animated green tick or red cross that draws itself (stroke animation), with a pop and a ring. */
export function StatusMark({ state, className, label }: { state: CheckState; className?: string; label?: string }) {
  if (!state) return null;
  return (
    <span
      key={state}
      className={cn('crew-mark', state === 'ok' ? 'crew-mark-ok' : 'crew-mark-bad', className)}
      role="img"
      aria-label={label ?? (state === 'ok' ? 'Correct' : 'Not correct')}
      data-testid={state === 'ok' ? 'mark-ok' : 'mark-bad'}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle className="crew-mark-ring" cx="12" cy="12" r="10" />
        {state === 'ok' ? <path className="crew-mark-path" d="M7 12.5l3.2 3.2L17 9" /> : <><path className="crew-mark-path" d="M8.5 8.5l7 7" /><path className="crew-mark-path crew-mark-path-2" d="M15.5 8.5l-7 7" /></>}
      </svg>
    </span>
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** A plain-language problem with a typed email, or null when it looks right. */
export function emailProblem(v: string): string | null {
  const s = v.trim();
  if (!s) return 'Enter your work email';
  if (/\s/.test(s)) return 'An email address has no spaces';
  if (!s.includes('@')) return 'Add the @ and your company domain, such as name@company.com';
  if (s.indexOf('@') !== s.lastIndexOf('@')) return 'Use only one @';
  if (!EMAIL.test(s)) return 'Finish the domain, such as name@company.com';
  return null;
}

/**
 * The work email box with live validation: a green tick once it is a complete address, a red cross and a plain
 * message when it is not (shown after leaving the box or once an @ is typed), and the green tick again when the sign-in
 * succeeded.
 */
export const EmailInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { verified?: boolean }>(function EmailInput({ className, verified, onChange, onBlur, ...props }, ref) {
  const [value, setValue] = useState(String(props.defaultValue ?? ''));
  const [touched, setTouched] = useState(false);
  const problem = emailProblem(value);
  const show = touched || value.includes('@');
  const state: CheckState = verified ? 'ok' : !value ? null : problem ? (show ? 'bad' : null) : 'ok';
  const msgId = props.id ? `${props.id}-check` : undefined;
  return (
    <div className="crew-check-wrap" data-check={state ?? ''}>
      <div className="relative">
      <input
        ref={ref}
        type="email"
        className={cn(inputControlClass, 'h-9 pr-10', className)}
        {...props}
        aria-invalid={props['aria-invalid'] || (state === 'bad' ? true : undefined)}
        aria-describedby={cn(props['aria-describedby'], state === 'bad' && msgId) || undefined}
        onChange={(e) => { setValue(e.target.value); onChange?.(e); }}
        onBlur={(e) => { setTouched(true); onBlur?.(e); }}
      />
      <span className="crew-check-slot pointer-events-none absolute inset-y-0 right-0 flex w-10 items-center justify-center"><StatusMark state={state} label={state === 'ok' ? 'Email looks right' : 'Email is not complete'} /></span>
      </div>
      {state === 'bad' && problem && !props['aria-invalid'] && <p id={msgId} className="crew-check-msg mt-1.5 text-[0.75rem] font-medium text-danger" data-testid="email-check">{problem}</p>}
    </div>
  );
});

/** The rules a new password must meet (the API checks the same ones). */
export function passwordRules(v: string) {
  const kinds = [/[a-z]/.test(v), /[A-Z]/.test(v), /\d/.test(v), /[^A-Za-z0-9]/.test(v)].filter(Boolean).length;
  return [
    { key: 'length', label: '12 or more characters', ok: v.length >= 12 },
    { key: 'mix', label: 'Three of: lowercase, uppercase, numbers, symbols', ok: kinds >= 3 },
  ];
}

/** A live checklist under a new password: each rule turns green with a tick as it is met. */
export function PasswordRules({ value, className }: { value: string; className?: string }) {
  const rules = passwordRules(value);
  const met = rules.filter((r) => r.ok).length;
  return (
    <div className={cn('crew-rules grid gap-1.5', className)} data-testid="password-rules" aria-live="polite">
      <div className="crew-strength" data-level={value ? met : -1} aria-hidden><span /><span /></div>
      <ul className="grid gap-1">
        {rules.map((r) => (
          <li key={r.key} className={cn('flex items-center gap-1.5 text-[0.75rem]', r.ok ? 'text-success' : 'text-fg-muted')} data-ok={r.ok}>
            <span className="inline-flex size-4 items-center justify-center">{value ? <StatusMark state={r.ok ? 'ok' : 'bad'} className="crew-mark-sm" /> : <span className="size-1.5 rounded-full bg-fg-subtle" />}</span>
            {r.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
