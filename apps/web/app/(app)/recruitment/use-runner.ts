'use client';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { ActionResult } from '@/lib/api';

export type Notice = { tone: 'success' | 'danger'; text: string } | null;

/** Runs a server action, shows its message and refreshes the page on success. */
export function useRunner() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<Notice>(null);
  const run = (fn: () => Promise<ActionResult<unknown>>, after?: (data: unknown) => void) =>
    start(async () => {
      const r = await fn();
      setNotice(r.ok ? { tone: 'success', text: r.message ?? 'Saved.' } : { tone: 'danger', text: r.message });
      if (r.ok) {
        after?.(r.data);
        router.refresh();
      }
    });
  return { pending, notice, setNotice, run };
}
