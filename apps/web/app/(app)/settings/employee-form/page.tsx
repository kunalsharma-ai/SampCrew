import type { EmployeeFormSettings } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { EmployeeFormEditor } from './form-editor';

export const metadata: Metadata = { title: 'Add Employee form' };

export default async function EmployeeFormPage() {
  const settings = await load<EmployeeFormSettings>('/employee-form');
  return (
    <>
      <PageHeader
        title="Add Employee form"
        description="How the Add Employee form works for every HR Workspace: your company's work email domain, which fields show, which are required and what they are called. Fields the hire cannot work without are always shown."
        actions={<Link className="text-sm font-medium text-accent hover:underline" href="/settings/custom-fields">Extra fields (custom fields)</Link>}
      />
      <EmployeeFormEditor settings={settings} />
    </>
  );
}
