import type { CrmContext } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { ReactNode } from 'react';
import { SubNav } from '@/components/sub-nav';

const SECTIONS = [
  { href: '/recruitment/crm', label: 'Overview' },
  { href: '/recruitment/crm/candidates', label: 'All Candidates' },
  { href: '/recruitment/crm/pipeline', label: 'Recruitment Pipeline' },
  { href: '/recruitment/crm/follow-ups', label: 'Follow-ups' },
  { href: '/recruitment/crm/activities', label: 'Activities' },
  { href: '/recruitment/crm/fields', label: 'Custom Fields' },
  { href: '/recruitment/crm/import', label: 'Import', cap: 'import' },
  { href: '/recruitment/crm/export', label: 'Export to Excel', cap: 'export' },
  { href: '/recruitment/crm/settings', label: 'CRM Settings' },
] as const;

/** The Candidate CRM page frame: title, the sections as tabs (those the person can use), then the page. */
export function CrmShell({ ctx, current, title, description, actions, overdue, children }: {
  ctx: CrmContext; current: string; title: string; description?: string; actions?: ReactNode; overdue?: number; children: ReactNode;
}) {
  const items = SECTIONS.filter((s) => !('cap' in s) || ctx.caps.includes(s.cap)).map((s) => ({
    href: s.href, label: s.label, ...(s.href.endsWith('follow-ups') && overdue ? { count: overdue, alert: true } : {}),
  }));
  const where = ctx.level === 'super' ? 'Super Workspace · every HR Workspace' : ctx.workspaces.map((w) => w.name).join(', ');
  return (
    <>
      <PageHeader eyebrow={`Recruitment & ATS · Candidate CRM · ${where}`} title={title} description={description} actions={actions} />
      <SubNav label="Candidate CRM sections" items={items} current={current} />
      {children}
    </>
  );
}
