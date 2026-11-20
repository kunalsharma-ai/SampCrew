import type { PasswordResetList } from '@crew/contracts';
import { PageHeader, PasswordResetRecord, passwordResetFilters } from '@crew/ui';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { load } from '@/lib/api';
import type { Me } from '@/lib/types';

export const metadata: Metadata = { title: 'Password resets' };
export const dynamic = 'force-dynamic';

/** Super Workspace: every "Forgot password?" by the company's people (HR Workspace and Employee Workspace too), as it happens. */
export default async function PasswordResetsPage({ searchParams }: { searchParams: Promise<{ level?: string; status?: string; q?: string; page?: string }> }) {
  const me = await load<Me>('/me');
  if (!me.levels.super) redirect('/no-access');
  const { query, params } = passwordResetFilters(await searchParams, 'workspace');
  const data = await load<PasswordResetList>(`/password-resets?${params}`);
  return (
    <>
      <PageHeader
        title="Password resets"
        description="Everyone in your company who used &quot;Forgot password?&quot; on the Web Portal or the phone app, newest first: whether they changed their password and whether the email reached them. SampCrew never shows or stores the link or code."
      />
      <PasswordResetRecord data={data} query={query} basePath="/settings/password-resets" scope="workspace" />
    </>
  );
}
