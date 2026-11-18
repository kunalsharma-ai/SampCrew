import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import type { Admin, StatutoryPackView } from '@/lib/types';
import { StatutoryPacksView } from './statutory-packs-view';

export const metadata: Metadata = { title: 'Country packs' };

export default async function StatutoryPacksPage() {
  const [me, packs] = await Promise.all([load<Admin>('/platform/auth/me'), load<StatutoryPackView[]>('/platform/statutory-packs')]);
  return (
    <>
      <PageHeader
        title="Payroll country packs"
        description="The starting statutory settings (social security, pension and income tax) a workspace gets for a legal entity in each country. They are kept in the database: change a rate here or add a new country without a release. Workspaces keep the settings they already saved; a change here only fills the form for entities that have not saved theirs."
      />
      <StatutoryPacksView packs={packs} canManage={hasCap(me, 'statutory:manage')} />
    </>
  );
}
