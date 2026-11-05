import type { WorkspaceUserRow } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { UsersView } from '@/components/users-view';
import { load } from '@/lib/api';

export const metadata: Metadata = { title: 'All users' };
const PAGE_SIZE = 50;

export default async function AllUsersPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; page?: string }> }) {
  const sp = await searchParams;
  const q = (sp.q ?? '').slice(0, 100);
  const status = ['active', 'invited', 'suspended'].includes(sp.status ?? '') ? sp.status! : '';
  const page = Math.max(1, Number(sp.page) || 1);
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE), ...(q ? { q } : {}), ...(status ? { status } : {}) });
  const data = await load<{ items: WorkspaceUserRow[]; total: number; summary: Record<string, number> }>(`/platform/users?${params}`);
  return (
    <>
      <PageHeader title="All users" description="Everyone the workspace admins have added, across every CREW workspace: roles, status, sign-ins and open web and mobile sessions. Account details only; HR records stay with the customer." />
      <UsersView data={data} query={{ q, status, page }} basePath="/users" showWorkspace pageSize={PAGE_SIZE} />
    </>
  );
}
