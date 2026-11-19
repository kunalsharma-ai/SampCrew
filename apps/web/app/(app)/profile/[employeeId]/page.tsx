import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { load } from '@/lib/api';
import type { FullProfile } from '@/lib/types';
import { ProfileView } from '../profile-view';

export const metadata: Metadata = { title: 'Employee profile' };

export default async function FullProfilePage({ params, searchParams }: { params: Promise<{ employeeId: string }>; searchParams: Promise<{ tab?: string }> }) {
  const [{ employeeId }, { tab }] = await Promise.all([params, searchParams]);
  const profile = await load<FullProfile>(`/profile/${employeeId}`);
  if (profile.self) redirect(`/profile${tab ? `?tab=${tab}` : ''}`);
  return (
    <>
      <PageHeader
        eyebrow={<Link href={`/employees/${employeeId}`} className="hover:underline">Employee record</Link>}
        title={profile.employee.name}
        description={profile.can.editDirect ? 'You can change these details directly. The employee is told, and every change is audited.' : 'Read only.'}
      />
      <ProfileView profile={profile} tab={tab} />
    </>
  );
}
