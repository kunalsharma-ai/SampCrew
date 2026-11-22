import type { SupportConversationView } from '@crew/contracts';
import { load } from '@/lib/api';

export interface Inbox { items: SupportConversationView[]; counts: Record<string, number>; unread: number }

export const inboxQuery = (sp: { q?: string; state?: string; tenant?: string }) => {
  const p = new URLSearchParams();
  if (sp.q) p.set('q', sp.q);
  if (sp.state && sp.state !== 'all') p.set('state', sp.state);
  if (sp.tenant) p.set('tenantId', sp.tenant);
  return p.toString();
};

export const loadInbox = (sp: { q?: string; state?: string; tenant?: string }) => load<Inbox>(`/platform/support/conversations?${inboxQuery(sp)}`);
