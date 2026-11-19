import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import type { Me } from '@/lib/types';
import type { Agency, CaseRow, Verifier } from './types';
import { CasesView } from './cases-view';

export const metadata: Metadata = { title: 'Background verification' };

export default async function VerificationPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string; method?: string; create?: string }> }) {
  const sp = await searchParams;
  const status = sp.status ?? 'open';
  const params = new URLSearchParams({ ...(status !== 'all' ? { status } : {}), ...(sp.q ? { q: sp.q } : {}), ...(sp.method ? { method: sp.method } : {}) });
  const me = await load<Me>('/me');
  const canCreate = Boolean(me.permissions['bgv:create']);
  // Opened from an employee's profile: the Start dialog opens with that person already chosen.
  const forId = canCreate && sp.create && /^[0-9a-f-]{36}$/i.test(sp.create) ? sp.create : null;
  const [cases, agencies, verifiers, forEmployee] = await Promise.all([
    load<CaseRow[]>(`/bgv/cases?${params}`),
    loadOptional<Agency[]>('/bgv/agencies'),
    canCreate ? loadOptional<Verifier[]>('/bgv/verifiers') : Promise.resolve(null),
    forId ? loadOptional<{ id: string; displayName: string }>(`/employees/${forId}`) : Promise.resolve(null),
  ]);
  return (
    <>
      <PageHeader title="Background verification" description="Identity, address, education, employment, reference and document checks for each employee, done by HR or by an agency. Only people with Background verification access see these records." />
      <CasesView cases={cases} agencies={agencies ?? []} verifiers={verifiers ?? []} filters={{ status, q: sp.q ?? '', method: sp.method ?? '' }}
        startFor={forEmployee ? { id: forEmployee.id, name: forEmployee.displayName } : null}
        can={{ create: canCreate, export: Boolean(me.permissions['bgv:export']), manage: Boolean(me.permissions['bgv:manage']) }} />
    </>
  );
}
