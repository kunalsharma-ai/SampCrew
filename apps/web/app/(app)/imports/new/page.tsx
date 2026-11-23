import { IMPORT_MAX_FILE_BYTES, IMPORT_JOB_MAX_ROWS, IMPORT_TYPE_INFO, IMPORT_TYPES, type ImportType, MASTER_LIST_INFO, VALUE_LISTS, type ValueList } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { UploadView } from './upload-view';

export const metadata: Metadata = { title: 'New import' };

export default async function NewImportPage({ searchParams }: { searchParams: Promise<{ type?: string; list?: string }> }) {
  const sp = await searchParams;
  if (!(IMPORT_TYPES as readonly string[]).includes(sp.type ?? '')) redirect('/imports');
  const type = sp.type as ImportType;
  const list = type === 'master_values' ? ((VALUE_LISTS as readonly string[]).includes(sp.list ?? '') ? (sp.list as ValueList) : 'job_role') : null;
  const info = IMPORT_TYPE_INFO[type];
  return (
    <>
      <PageHeader
        eyebrow={<Link href="/imports" className="hover:underline">Data import</Link>}
        title={`Import ${list ? MASTER_LIST_INFO[list].label.toLowerCase() : info.label.toLowerCase()}`}
        description={info.description}
      />
      <UploadView type={type} list={list} lists={type === 'master_values' ? VALUE_LISTS.map((l) => ({ key: l, label: MASTER_LIST_INFO[l].label })) : []} maxMb={IMPORT_MAX_FILE_BYTES / 1024 / 1024} maxRows={IMPORT_JOB_MAX_ROWS} />
    </>
  );
}
