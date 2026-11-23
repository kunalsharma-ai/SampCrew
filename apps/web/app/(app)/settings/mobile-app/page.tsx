import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { MobileAppVersion } from './actions';
import { MobileAppManager } from './mobile-app-manager';
import type { MobileAppOverview } from './types';

export const metadata: Metadata = { title: 'Mobile app' };

export default async function MobileAppPage() {
  const [overview, versions] = await Promise.all([load<MobileAppOverview>('/mobile-app'), load<MobileAppVersion[]>('/mobile-app/versions')]);
  return (
    <>
      <PageHeader
        eyebrow="Super Workspace"
        title="Mobile app"
        description="One SampCrew app for Super Workspace, HR Workspace and Employee Workspace. Choose what phones show to each level, preview it, then publish. Hiding a module never deletes its data and never changes the Web Portal."
      />
      <MobileAppManager initial={overview} initialVersions={versions} />
    </>
  );
}
