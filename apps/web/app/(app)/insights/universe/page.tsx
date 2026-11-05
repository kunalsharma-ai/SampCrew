import type { RecruitmentFlow, Scenario, ScenarioBaseline, SkillCatalogueEntry, SkillsNetwork, UniverseData } from '@crew/contracts';
import { buttonClass, Card, EmptyState, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load, loadOptional } from '@/lib/api';
import type { Me } from '@/lib/types';
import { FlowLens, LocationsLens, ScenariosLens, SkillsLens } from './lenses';
import { SkillCatalogue } from './skill-catalogue';
import { UniverseView } from './universe-view';

export const metadata: Metadata = { title: 'Workforce Universe' };

const LENSES = [
  { key: 'org', label: 'Organization', description: 'Your organization in 3D, on any date. Departments are sized by headcount, people orbit their department, and amber lines show reporting that crosses departments. Play the timeline to watch joiners, moves and leavers.' },
  { key: 'locations', label: 'Locations', description: 'Where people work, on a globe. Pick a date to see how each location has grown, and turn the globe by dragging it.' },
  { key: 'skills', label: 'Skills', description: 'The skills people hold, as a network. Skills held strongly by only one or two people are marked, so you can see where cover is thin.' },
  { key: 'flow', label: 'Recruitment flow', description: 'How candidates moved through hiring: how many reached each stage, moved on, were turned down or withdrew.', permission: 'requisitions:read' },
  { key: 'scenarios', label: 'Scenarios', description: 'What-if headcount plans by department, with the monthly cost when you can see pay. Plans are saved for others to open; they change nothing.', permission: 'reports:read' },
] as const;
type Lens = (typeof LENSES)[number]['key'];

export default async function UniversePage({ searchParams }: { searchParams: Promise<{ on?: string; view?: string; dept?: string; lens?: string; period?: string }> }) {
  const sp = await searchParams;
  const me = await load<Me>('/me');
  const lenses = LENSES.filter((l) => !('permission' in l) || me.permissions[l.permission]);
  const lens: Lens = lenses.find((l) => l.key === sp.lens)?.key ?? 'org';
  const current = LENSES.find((l) => l.key === lens)!;

  let body: React.ReactNode;
  if (lens === 'org' || lens === 'locations') {
    const data = await load<UniverseData>('/insights/universe');
    body = lens === 'org'
      ? <UniverseView data={data} initialOn={sp.on && /^\d{4}-\d{2}-\d{2}$/.test(sp.on) ? sp.on : null} initialView={sp.view === '2d' ? '2d' : sp.view === '3d' ? '3d' : null} initialDept={sp.dept && /^[0-9a-f-]{36}$/.test(sp.dept) ? sp.dept : null} />
      : <LocationsLens data={data} />;
  } else if (lens === 'skills') {
    const [net, list] = await Promise.all([load<SkillsNetwork>('/insights/skills'), load<{ skills: SkillCatalogueEntry[]; canManage: boolean }>('/skills')]);
    body = <div className="space-y-4"><SkillsLens net={net} /><SkillCatalogue skills={list.skills} canManage={list.canManage} /></div>;
  } else if (lens === 'flow') {
    const period = sp.period === 'year' || sp.period === 'all' ? sp.period : 'quarter';
    const flow = await loadOptional<RecruitmentFlow>(`/insights/recruitment-flow?period=${period}`);
    body = flow ? <FlowLens flow={flow} /> : <Card><EmptyState title="Recruitment is not available" description="Your plan or access does not include recruitment." /></Card>;
  } else {
    const s = await loadOptional<{ baseline: ScenarioBaseline; scenarios: Scenario[] }>('/insights/scenarios');
    body = s ? <ScenariosLens baseline={s.baseline} scenarios={s.scenarios} canSave={!!me.permissions['reports:read'] && me.permissions['reports:read'] !== 'own'} canRaise={!!me.permissions['requisitions:create'] && me.features.includes('recruitment')} /> : <Card><EmptyState title="Scenarios are not available" description="You need access to reports to plan headcount." /></Card>;
  }

  return (
    <>
      <PageHeader title="Workforce Universe" description={current.description} />
      <nav className="mb-4 flex flex-wrap gap-1 text-[0.8125rem]" role="tablist" aria-label="Lens">
        {lenses.map((l) => (
          <Link key={l.key} role="tab" aria-selected={l.key === lens} href={l.key === 'org' ? '/insights/universe' : `/insights/universe?lens=${l.key}`} className={buttonClass(l.key === lens ? 'secondary' : 'ghost', 'sm')}>{l.label}</Link>
        ))}
      </nav>
      {body}
    </>
  );
}
