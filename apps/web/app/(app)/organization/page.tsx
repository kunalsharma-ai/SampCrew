import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { can } from '@/lib/nav';
import type { BusinessUnit, Department, Designation, LegalEntity, Location, Me } from '@/lib/types';
import { OrgView } from './org-view';

export const metadata: Metadata = { title: 'Organization structure' };

const TABS = [
  { key: 'entities', label: 'Legal entities' },
  { key: 'locations', label: 'Locations' },
  { key: 'departments', label: 'Departments' },
  { key: 'designations', label: 'Designations' },
  { key: 'units', label: 'Business units' },
] as const;

export default async function OrganizationPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: rawTab } = await searchParams;
  const tab = (TABS.find((t) => t.key === rawTab)?.key ?? 'entities') as (typeof TABS)[number]['key'];
  const [me, entities, locations, departments, units, tree, designations] = await Promise.all([
    load<Me>('/me'),
    load<LegalEntity[]>('/org/legal-entities'),
    load<Location[]>('/org/locations'),
    load<Department[]>('/org/departments'),
    load<BusinessUnit[]>('/org/business-units'),
    load<Department[]>('/org/department-tree'),
    load<Designation[]>('/designations'),
  ]);
  return (
    <>
      <PageHeader
        title="Organization structure"
        description="Legal entities, sites, departments, designations and business units. Every person, policy and payroll in SampCrew hangs off this structure."
        actions={can(me, 'org:manage') ? <Link href="/setup" className="text-[0.8125rem] font-medium text-accent hover:underline">Company setup and ready-made lists</Link> : undefined}
      />
      <nav className="mb-5 flex gap-1 overflow-x-auto border-b border-border" aria-label="Structure sections">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/organization?tab=${t.key}`}
            aria-current={tab === t.key ? 'page' : undefined}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[0.8438rem] ${tab === t.key ? 'border-accent font-medium text-fg' : 'border-transparent text-fg-muted hover:text-fg'}`}
          >
            {t.label}
            <span className="ml-1.5 rounded-full bg-bg-subtle px-1.5 text-[0.6875rem] text-fg-subtle tabular">
              {{ entities: entities.length, locations: locations.length, departments: departments.length, designations: designations.length, units: units.length }[t.key]}
            </span>
          </Link>
        ))}
      </nav>
      <OrgView tab={tab} canManage={can(me, 'org:manage')} entities={entities} locations={locations} departments={departments} units={units} tree={tree} designations={designations} />
    </>
  );
}
