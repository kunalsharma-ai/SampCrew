import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { AccessEditor, type AccessSettings } from './access-editor';

export const metadata: Metadata = { title: 'Attendance permissions' };

/** Super Workspace only: the API refuses everyone else, and this page then shows "no access". */
export default async function AttendanceAccessPage() {
  const data = await load<AccessSettings>('/attendance/access');
  return (
    <>
      <PageHeader
        eyebrow={<Link href="/attendance" className="hover:underline">Attendance</Link>}
        title="Attendance permissions"
        description="Choose, for each HR Workspace, whether it may see other HR Workspaces' attendance and export what it can see. No HR Workspace ever sees Super Workspace attendance."
      />
      <AccessEditor data={data} />
    </>
  );
}
