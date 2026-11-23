import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import { CrmShell } from '../crm-shell';
import type { CrmContext } from '../crm-types';
import { type AccessRow, type CrmSettings, SettingsView } from './settings-view';

export const metadata: Metadata = { title: 'CRM Settings · Candidate CRM' };

export default async function CrmSettingsPage() {
  const ctx = await load<CrmContext>('/recruitment/crm/context');
  const [settings, access] = await Promise.all([
    load<CrmSettings>('/recruitment/crm/settings'),
    ctx.canManageAccess ? loadOptional<{ rows: AccessRow[] }>('/recruitment/crm/access') : null,
  ]);
  return (
    <CrmShell ctx={ctx} current="/recruitment/crm/settings" title="CRM Settings" description={ctx.level === 'super' ? 'Who can use Candidate CRM, the pipeline stages, sources and how long candidate data is kept.' : 'How Candidate CRM is set up for your organisation. Super Workspace changes these.'}>
      <SettingsView ctx={ctx} settings={settings} access={access?.rows ?? null} />
    </CrmShell>
  );
}
