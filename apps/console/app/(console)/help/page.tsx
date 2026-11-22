import type { HelpHome } from '@crew/contracts';
import { HelpHomeView } from '@crew/ui';
import type { Metadata } from 'next';
import { ConsoleHelp } from '@/components/help-centre';
import { load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import type { Admin } from '@/lib/types';

export const metadata: Metadata = { title: 'Help & Support' };

export default async function ConsoleHelpPage() {
  const [me, home] = [await load<Admin>('/platform/auth/me'), await load<HelpHome>('/platform/help')];
  // The answering inbox is for admins who may answer queries (help:answer).
  const view = { ...home, queries: { ...home.queries, inbox: hasCap(me, 'help:answer') } };
  return <ConsoleHelp><HelpHomeView home={view} /></ConsoleHelp>;
}
