import { buttonClass, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import type { FullProfile, Me } from '@/lib/types';
import { ProfileView } from './profile-view';

export const metadata: Metadata = { title: 'My profile' };

export default async function MyProfilePage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  const [profile, me] = await Promise.all([load<FullProfile>('/profile/me'), load<Me>('/me')]);
  return (
    <>
      <PageHeader
        title={profile.employee.name}
        description="Your personal, professional, education, bank and identity details. Changes you make go to HR for approval."
        actions={me.permissions['profiles:review'] ? <Link className={buttonClass('secondary')} href="/profile/updates">Profile updates to review</Link> : undefined}
      />
      <ProfileView profile={profile} tab={tab} />
    </>
  );
}
