import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { AccessEditor, type AccessSettings } from './access-editor';

export const metadata: Metadata = { title: 'Document access' };

export default async function DocumentAccessPage() {
  const settings = await load<AccessSettings>('/documents/access');
  return (
    <>
      <PageHeader
        title="Document Access Management"
        description="What each HR Workspace may do with documents. Super Workspace always sees everything. Changes apply at once, also to direct links, and are recorded. Switching something off never deletes a document."
      />
      <AccessEditor settings={settings} />
    </>
  );
}
