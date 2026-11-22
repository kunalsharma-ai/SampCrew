'use client';
import { HelpCentreProvider, type HelpActions } from '@crew/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { consoleAssignAction, consoleReplyAction, consoleStatusAction } from '@/app/(console)/help/actions';

const ACTIONS: HelpActions = { reply: consoleReplyAction, status: consoleStatusAction, assign: consoleAssignAction };

/** The shared help centre screens, wired to the Console: its links, router and the Console's own actions. */
export function ConsoleHelp({ children }: { children: ReactNode }) {
  const router = useRouter();
  return (
    <HelpCentreProvider value={{ base: '/help', queriesBase: '/help-queries', inboxBase: '/help-queries', Link, refresh: () => router.refresh(), push: (h) => router.push(h), actions: ACTIONS }}>
      {children}
    </HelpCentreProvider>
  );
}
