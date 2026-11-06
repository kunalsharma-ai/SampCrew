import type { CatalogueDepartment, CatalogueDesignation, Industry } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Location, Me } from '@/lib/types';
import { SetupWizard } from './setup-wizard';

export const metadata: Metadata = { title: 'Company setup' };

export interface SetupState {
  company: {
    name: string; industry: Industry | null; companySize: string | null; website: string | null; contactEmail: string | null; contactPhone: string | null;
    setupStep: number; setupCompletedAt: string | null; legalEntityId: string; legalName: string | null; countryCode: string; currency: string; timezone: string;
    fiscalYearStartMonth: number; registrationNumber: string | null; taxId: string | null; address: string | null;
  };
  counts: { locations: number; departments: number; designations: number; employees: number };
  departments: { id: string; name: string; code: string | null }[];
  designations: { id: string; name: string; code: string | null; level: number | null }[];
  suggestions: { departments: CatalogueDepartment[]; designations: CatalogueDesignation[] };
}

/**
 * The first-login company setup: company details, locations, departments and designations, then the first employee.
 * New workspaces' administrators land here from the home page until it is finished; it can be reopened any time.
 */
export default async function SetupPage({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const { step } = await searchParams;
  const me = await load<Me>('/me');
  const [setup, locations] = await Promise.all([load<SetupState>('/setup'), load<Location[]>('/org/locations')]);
  const canManage = can(me, 'org:manage');
  const start = step !== undefined && /^\d$/.test(step) ? Number(step) : setup.company.setupCompletedAt ? 0 : Math.min(setup.company.setupStep, 4);
  return (
    <>
      <PageHeader
        title={setup.company.setupCompletedAt ? 'Company setup' : `Welcome to CREW, ${me.user.fullName.split(' ')[0]}`}
        description={setup.company.setupCompletedAt
          ? 'Review your company details and structure. Changes apply straight away.'
          : 'A few minutes of setup before your first employee: your company, where you work, and your departments and designations.'}
      />
      <SetupWizard key={start} initialStep={start} setup={setup} locations={locations} canManage={canManage} />
    </>
  );
}
