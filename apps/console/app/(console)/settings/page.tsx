import type { ConsoleSettings } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import type { Admin } from '@/lib/types';
import { SettingsView } from './settings-view';

export const metadata: Metadata = { title: 'Settings' };

/** Global Console settings: defaults for new workspaces and users, support, security, notifications and branding. */
export default async function SettingsPage() {
  const [me, settings, plans] = await Promise.all([
    load<Admin>('/platform/auth/me'),
    load<ConsoleSettings>('/platform/settings'),
    load<{ key: string; name: string; archivedAt: string | null; retiredAt?: string | null }[]>('/platform/plans').catch(() => []),
  ]);
  return (
    <>
      <PageHeader title="Settings" description="Defaults for the whole platform. Each section saves on its own and is recorded in the audit log with before and after values. API keys live in Integrations, never here." />
      <SettingsView settings={settings} plans={plans.filter((p) => !p.archivedAt && !p.retiredAt).map((p) => ({ key: p.key, name: p.name }))} canManage={hasCap(me, 'settings:manage')} />
    </>
  );
}
