'use client';
import type { HelpQueryStatus, HelpReplyInput } from '@crew/contracts';
import { createContext, useContext, type ComponentType, type ReactNode } from 'react';

/** What a server action returns (the same shape as each app's `act()` helper). */
export type HelpActionResult<T = unknown> = { ok: true; data?: T; message?: string } | { ok: false; message: string; code?: string; fieldErrors?: Record<string, string> };

export interface HelpUploaded { id: string; name: string; type: string; size: number }

/**
 * The server actions behind the help centre. Each app (Web Portal, Console) passes its own; an action left out hides the
 * control that needs it (the Console's help has no helpful votes or tutorial progress, for example).
 */
export interface HelpActions {
  feedback?: (slug: string, helpful: boolean) => Promise<HelpActionResult>;
  progress?: (slug: string, step: number, done: boolean) => Promise<HelpActionResult>;
  upload?: (form: FormData) => Promise<HelpActionResult<HelpUploaded>>;
  raise?: (input: Record<string, unknown>) => Promise<HelpActionResult<{ id: string; ticketId: string; routeLabel: string; created: boolean }>>;
  reply?: (id: string, input: Partial<HelpReplyInput> & { body: string }) => Promise<HelpActionResult>;
  status?: (id: string, status: HelpQueryStatus, note?: string | null) => Promise<HelpActionResult>;
  assign?: (id: string, assigneeId: string | null) => Promise<HelpActionResult>;
  escalate?: (id: string, reason: string) => Promise<HelpActionResult>;
  rate?: (id: string, rating: number, comment: string | null) => Promise<HelpActionResult>;
}

export type HelpLinkComponent = ComponentType<{ href: string; className?: string; children: ReactNode; 'aria-current'?: 'page' | undefined; 'data-testid'?: string; title?: string; prefetch?: boolean }>;

export interface HelpCentreConfig {
  /** Where the help centre lives: /help in both apps. */
  base: string;
  /** Where the queries pages live (the Console's are under /help-queries). */
  queriesBase: string;
  /** Where the answering inbox lives (Web Portal /help/inbox, Console /help-queries). */
  inboxBase: string;
  Link: HelpLinkComponent;
  refresh: () => void;
  push: (href: string) => void;
  actions: HelpActions;
}

const PlainLink: HelpLinkComponent = ({ href, children, prefetch: _p, ...rest }) => <a href={href} {...rest}>{children}</a>;

const Ctx = createContext<HelpCentreConfig>({
  base: '/help', queriesBase: '/help/queries', inboxBase: '/help/inbox', Link: PlainLink,
  refresh: () => { if (typeof window !== 'undefined') window.location.reload(); },
  push: (href) => { if (typeof window !== 'undefined') window.location.assign(href); },
  actions: {},
});

export function HelpCentreProvider({ value, children }: { value: Partial<HelpCentreConfig>; children: ReactNode }) {
  const parent = useContext(Ctx);
  return <Ctx.Provider value={{ ...parent, ...value, actions: { ...parent.actions, ...value.actions } }}>{children}</Ctx.Provider>;
}

export const useHelpCentre = () => useContext(Ctx);
