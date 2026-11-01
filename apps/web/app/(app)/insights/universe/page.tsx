import type { UniverseData } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { UniverseView } from './universe-view';

export const metadata: Metadata = { title: 'Workforce Universe' };

export default async function UniversePage({ searchParams }: { searchParams: Promise<{ on?: string; view?: string; dept?: string }> }) {
  const sp = await searchParams;
  const data = await load<UniverseData>('/insights/universe');
  return (
    <>
      <PageHeader
        title="Workforce Universe"
        description="Your organization in 3D, on any date. Departments are sized by headcount, people orbit their department, and amber lines show reporting that crosses departments. Play the timeline to watch joiners, moves and leavers."
      />
      <UniverseView
        data={data}
        initialOn={sp.on && /^\d{4}-\d{2}-\d{2}$/.test(sp.on) ? sp.on : null}
        initialView={sp.view === '2d' ? '2d' : sp.view === '3d' ? '3d' : null}
        initialDept={sp.dept && /^[0-9a-f-]{36}$/.test(sp.dept) ? sp.dept : null}
      />
    </>
  );
}
