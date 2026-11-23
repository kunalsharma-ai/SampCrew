import type { WorkspaceUserRow } from '@crew/contracts';
import { Alert } from '@crew/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { UsersView } from '@/components/users-view';
import { load } from '@/lib/api';
import { ClientHeader } from '../client-header';
import { loadClient } from '../load-client';

export const metadata: Metadata = { title: 'Company users' };
const PAGE = 50;

/** People in every Super Workspace of the company: names, levels, status and sign-in. Emails masked without users:pii. */
export default async function ClientUsersPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ q?: string; status?: string; page?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const r = await loadClient(id);
  if (!r) notFound();
  const { c, caps } = r;
  const page = Math.max(1, Number(sp.page) || 1);
  const qs = new URLSearchParams({ limit: String(PAGE), offset: String((page - 1) * PAGE) });
  if (sp.q) qs.set('q', sp.q.slice(0, 120));
  if (sp.status && ['active', 'invited', 'suspended'].includes(sp.status)) qs.set('status', sp.status);
  const data = caps.includes('users:read') ? await load<{ items: WorkspaceUserRow[]; total: number; summary: Record<string, number>; piiMasked: boolean }>(`/platform/clients/${id}/users?${qs}`) : null;
  return (
    <>
      <ClientHeader c={c} current="users" caps={caps} />
      {!data ? <Alert tone="warning">Your role cannot see users of client workspaces.</Alert> : (
        <>
          {data.piiMasked && <Alert tone="info" className="mb-4">Email addresses are masked for your role.</Alert>}
          <UsersView data={data} query={{ q: sp.q ?? '', status: sp.status ?? '', page }} basePath={`/clients/${id}/users`} showWorkspace={c.workspaces.length > 1} pageSize={PAGE} canAct={caps.includes('access:manage')} />
        </>
      )}
    </>
  );
}
