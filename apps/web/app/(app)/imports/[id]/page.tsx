import { IMPORT_TYPE_INFO, type ImportJobView, MASTER_LIST_INFO } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { load, loadOptional, loadSession } from '@/lib/api';
import type { Me } from '@/lib/types';
import { ImportWizard } from './wizard';

export const metadata: Metadata = { title: 'Import' };

export default async function ImportJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [job, me] = await Promise.all([load<ImportJobView>(`/imports/${id}`), loadSession<Me>('/me')]);
  const companyWide = me.levels.super || me.levels.companyHr;
  // Where imported employees go: any HR Workspace (or the central group) for the Super Workspace, otherwise your own.
  const hrWorkspaces = job.type !== 'employees' ? [] : companyWide
    ? ((await loadOptional<{ items: { id: string; name: string }[] }>('/hr-workspaces?status=active'))?.items ?? []).map((w) => ({ id: w.id, name: w.name }))
    : me.levels.hrWorkspaces.filter((w) => w.status === 'active').map((w) => ({ id: w.id, name: w.name }));
  const info = IMPORT_TYPE_INFO[job.type];
  const what = job.list ? MASTER_LIST_INFO[job.list as keyof typeof MASTER_LIST_INFO]?.label ?? info.label : info.label;
  return (
    <>
      <PageHeader
        eyebrow={<Link href="/imports" className="hover:underline">Data import</Link>}
        title={`Import #${job.number}: ${what.toLowerCase()}`}
        description={`${job.fileName} · ${job.rowCount.toLocaleString('en-IN')} rows · ${job.headers.length} columns`}
      />
      <ImportWizard initial={job} hrWorkspaces={hrWorkspaces} companyWide={companyWide} />
    </>
  );
}
