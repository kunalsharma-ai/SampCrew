import { Alert, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import type { Admin } from '@/lib/types';
import { NewClientWizard } from './new-client-wizard';

export const metadata: Metadata = { title: 'New company' };

/** Create Company: the company profile, then its first Super Workspace with its admin, plan and trial. */
export default async function NewClientPage() {
  const me = await load<Admin>('/platform/auth/me');
  if (!hasCap(me, 'tenants:manage')) return <><PageHeader title="New company" /><Alert tone="warning">Your role cannot create companies.</Alert></>;
  const [plans, managers] = await Promise.all([
    load<{ key: string; name: string; archivedAt: string | null; retiredAt?: string | null }[]>('/platform/plans'),
    load<{ id: string; name: string }[]>('/platform/clients/managers').catch(() => []),
  ]);
  return (
    <>
      <PageHeader title="New company" description="Add a client company and its first Super Workspace. Its Super Workspace Admin then sets up HR Workspaces and people. Public company details can be looked up from Brandfetch once the company exists." />
      <NewClientWizard plans={plans.filter((p) => !p.archivedAt && !p.retiredAt).map((p) => ({ key: p.key, name: p.name }))} managers={managers} />
    </>
  );
}
