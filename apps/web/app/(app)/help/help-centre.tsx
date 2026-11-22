'use client';
import { HelpCentreProvider, type HelpActions } from '@crew/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import {
  helpFeedbackAction, helpProgressAction, helpUploadAction, inboxAssignAction, inboxEscalateAction, inboxReplyAction, inboxStatusAction, myReplyAction, myStatusAction,
  raiseQueryAction, rateQueryAction,
} from './actions';

const READER: HelpActions = { feedback: helpFeedbackAction, progress: helpProgressAction, upload: helpUploadAction, raise: raiseQueryAction };
const MINE: HelpActions = { ...READER, reply: myReplyAction, status: myStatusAction, rate: rateQueryAction };
const INBOX: HelpActions = { upload: helpUploadAction, reply: inboxReplyAction, status: inboxStatusAction, assign: inboxAssignAction, escalate: inboxEscalateAction };

/** The shared help centre screens wired to the Web Portal: next/link, the router and this app's server actions. */
export function WebHelp({ mode = 'mine', children }: { mode?: 'mine' | 'inbox'; children: ReactNode }) {
  const router = useRouter();
  return (
    <HelpCentreProvider value={{ base: '/help', queriesBase: '/help/queries', inboxBase: '/help/inbox', Link, refresh: () => router.refresh(), push: (h) => router.push(h), actions: mode === 'inbox' ? INBOX : MINE }}>
      {children}
    </HelpCentreProvider>
  );
}
