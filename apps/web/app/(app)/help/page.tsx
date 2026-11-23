import type { HelpHome } from '@crew/contracts';
import { HelpHomeView } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { WebHelp } from './help-centre';

export const metadata: Metadata = { title: 'Help & Support' };

export default async function HelpPage() {
  const home = await load<HelpHome>('/help');
  return <WebHelp><HelpHomeView home={home} /></WebHelp>;
}
