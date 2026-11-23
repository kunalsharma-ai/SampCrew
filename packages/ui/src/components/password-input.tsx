'use client';

import { forwardRef, useState, type InputHTMLAttributes } from 'react';
import { cn } from '../cn';
import { inputControlClass } from './form';
import { PasswordRules, StatusMark, type CheckState } from './sign-in-feedback';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  /** A green tick (the password was right) or a red cross (it was wrong) drawn inside the box. */
  check?: CheckState;
  /** A new password: shows the live rule checklist and strength bar under the box. */
  rules?: boolean;
  /** A confirmation box: the name of the password field it must match; a tick or cross shows as you type. */
  matches?: string;
};

/**
 * A password box with an eye button that shows or hides what was typed. Used on every sign-in, reset and change
 * password form (Console, Super Workspace, HR Workspace and Employee Workspace). It can also show whether the
 * password was right, the rules a new password must meet, and whether a confirmation matches.
 */
export const PasswordInput = forwardRef<HTMLInputElement, Props>(function PasswordInput({ className, check, rules, matches, onChange, ...props }, ref) {
  const [shown, setShown] = useState(false);
  const [value, setValue] = useState('');
  const [match, setMatch] = useState<CheckState>(null);
  const mark: CheckState = check ?? match;
  return (
    <div className={cn('crew-password-wrap relative', mark === 'bad' && check === 'bad' && 'crew-shake')} data-check={mark ?? ''}>
      <div className="relative">
        <input
          ref={ref}
          type={shown ? 'text' : 'password'}
          className={cn(inputControlClass, 'crew-password h-9', mark ? 'pr-[4.5rem]' : 'pr-10', className)}
          spellCheck={false}
          autoCapitalize="none"
          {...props}
          aria-invalid={props['aria-invalid'] || (mark === 'bad' ? true : undefined)}
          onChange={(e) => {
            setValue(e.target.value);
            if (matches) {
              const other = (e.target.form?.elements.namedItem(matches) as HTMLInputElement | null)?.value ?? '';
              setMatch(!e.target.value ? null : e.target.value === other ? 'ok' : other.startsWith(e.target.value) ? null : 'bad');
            }
            onChange?.(e);
          }}
        />
        {mark && (
          <span className="crew-check-slot pointer-events-none absolute inset-y-0 right-10 flex w-8 items-center justify-center">
            <StatusMark state={mark} label={matches && !check ? (mark === 'ok' ? 'Passwords match' : 'Passwords do not match') : mark === 'ok' ? 'Password is correct' : 'Password is not correct'} />
          </span>
        )}
        <button
          type="button"
          className="crew-password-eye absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-fg-subtle transition-colors hover:text-fg focus-visible:text-accent focus-visible:outline-none"
          onClick={() => setShown((v) => !v)}
          aria-label={shown ? 'Hide password' : 'Show password'}
          aria-pressed={shown}
          title={shown ? 'Hide password' : 'Show password'}
          data-testid="password-eye"
          disabled={props.disabled}
        >
          {shown ? (
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3l18 18" /><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6A17.4 17.4 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
          )}
        </button>
      </div>
      {rules && <PasswordRules value={value} className="mt-2" />}
      {matches && match === 'bad' && <p className="mt-1.5 text-[0.75rem] font-medium text-danger" data-testid="password-match">The two passwords do not match yet</p>}
    </div>
  );
});
