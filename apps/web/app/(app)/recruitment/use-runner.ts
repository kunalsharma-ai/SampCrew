'use client';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useMfaRetry } from '@/components/mfa-step-up';
import type { ActionResult } from '@/lib/api';

export type Notice = { tone: 'success' | 'danger'; text: string } | null;

/**
 * Runs a server action, shows its message and refreshes the page on success. An action that needs two-step
 * verification opens the verification dialog and runs again once the person has verified.
 */
export function useRunner() {
  const router = useRouter();
  const withMfa = useMfaRetry();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<Notice>(null);
  const run = (fn: () => Promise<ActionResult<unknown>>, after?: (data: unknown) => void) =>
    start(async () => {
      const r = await withMfa(fn);
      setNotice(r.ok ? { tone: 'success', text: r.message ?? 'Saved.' } : { tone: 'danger', text: r.message });
      if (r.ok) {
        after?.(r.data);
        router.refresh();
      }
    });
  return { pending, notice, setNotice, run };
}
