import type { PasswordResetList } from '@crew/contracts';
import { PageHeader, PasswordResetRecord, passwordResetFilters } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';

export const metadata: Metadata = { title: 'Password resets' };
export const dynamic = 'force-dynamic';

/** Every "Forgot password?" at every level: Console Admin, Super Workspace, HR Workspace and Employee Workspace. */
export default async function ConsolePasswordResetsPage({ searchParams }: { searchParams: Promise<{ level?: string; status?: string; q?: string; page?: string }> }) {
  const { query, params } = passwordResetFilters(await searchParams, 'console');
  const data = await load<PasswordResetList>(`/platform/password-resets?${params}`);
  return (
    <>
      <PageHeader
        title="Password resets"
        description="Every &quot;Forgot password?&quot; request across SampCrew, newest first: Console Admins and the people of every workspace, with their level, whether the password was changed and whether the email was delivered. Requests for unknown emails are listed too."
      />
      <PasswordResetRecord data={data} query={query} basePath="/password-resets" scope="console" />
    </>
  );
}
