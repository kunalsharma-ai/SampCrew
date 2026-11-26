import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { TemplatesEditor } from './templates-editor';
import type { EmailTemplates } from './types';

export const metadata: Metadata = { title: 'Email templates' };

export default async function EmailTemplatesPage() {
  const data = await load<EmailTemplates>('/settings/email-templates');
  return (
    <>
      <PageHeader
        title="Email templates"
        description="Make the emails SampCrew sends for your company look like your company's. Import your own HTML design for every email, or for one kind of email. The message goes where the template has {{content}}."
        actions={<Link className="text-sm font-medium text-accent hover:underline" href="/settings/email">Email setup</Link>}
      />
      <TemplatesEditor data={data} />
    </>
  );
}
