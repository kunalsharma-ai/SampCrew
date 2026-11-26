import type { MemberPreferences } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { HomeSetupView } from './home-setup-view';

export const metadata: Metadata = { title: 'Home dashboard' };

/** Settings > Home dashboard (issue #86): which count cards and sections the person's Home shows. */
export default async function HomeSetupPage() {
  const prefs = await load<MemberPreferences>('/me/preferences');
  return (
    <>
      <PageHeader title="Home dashboard" description="Choose the count cards and sections your Home shows. Only you see these choices; switch anything back on at any time." />
      <HomeSetupView hiddenCards={prefs.experience.hiddenCards} hiddenSections={prefs.experience.hiddenSections} />
    </>
  );
}
