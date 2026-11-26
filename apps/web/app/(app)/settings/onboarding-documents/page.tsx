import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load, loadOptional } from '@/lib/api';
import type { Library } from '../../onboarding-documents/types';
import { LibraryEditor } from './library-editor';

export const metadata: Metadata = { title: 'Onboarding document library' };

export default async function OnboardingLibraryPage() {
  const [library, departments] = await Promise.all([
    load<Library>('/onboarding-documents/library'),
    loadOptional<{ id: string; name: string }[]>('/org/departments'),
  ]);
  return (
    <>
      <PageHeader
        title="Onboarding document library"
        description={library.level === 'super'
          ? 'The documents your company can ask new joiners for, grouped in categories, and the templates HR chooses from in the Add Employee form. HR Workspaces use this library; you decide whether they may change it.'
          : library.canManage
            ? 'The Super Workspace lets your HR Workspace manage this library. Every change is recorded and the Super Workspace is told. Sensitive documents stay optional unless the Super Workspace makes them mandatory.'
            : 'The documents and templates the Super Workspace set up. Ask the Super Workspace for a document that is missing, or for permission to manage the library.'}
        actions={<Link className="text-sm font-medium text-accent hover:underline" href="/onboarding-documents">Onboarding progress</Link>}
      />
      <LibraryEditor library={library} departments={(departments ?? []).map((d) => ({ id: d.id, name: d.name }))} />
    </>
  );
}
