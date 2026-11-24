import type { PublicHelpHome } from '@crew/contracts';
import type { Metadata } from 'next';
import { api } from '@/lib/api';
import { SupportView } from './view';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: { absolute: 'Help & Support · SampCrew' },
  description: 'Everything about SampCrew: our features, what we offer, FAQs, guides and how to get help.',
  robots: { index: true, follow: true },
};

/**
 * The public Help & Support centre: anyone can open it from any sign-in page, before signing in. Its content is
 * written by SampCrew's Console admins (Help content, audience "Everyone (public Help & Support)") and read from the
 * API, so a new FAQ, article or feature brief shows here as soon as it is published.
 */
export default async function HelpAndSupportPage() {
  const home = await api<PublicHelpHome>('/public/help', { auth: false });
  return <SupportView home={home} />;
}
