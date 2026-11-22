import { redirect } from 'next/navigation';
import { load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import type { Admin } from '@/lib/types';
import { Shell, type NavItem } from './shell';

const NAV: (NavItem & { cap?: string })[] = [
  { href: '/', label: 'Overview', icon: 'gauge', cap: 'tenants:read' },
  { href: '/tenants', label: 'Workspaces', icon: 'building', cap: 'tenants:read' },
  { href: '/support', label: 'Support inbox', icon: 'headset', cap: 'support:chat' },
  { href: '/users', label: 'All users', icon: 'users', cap: 'access:manage' },
  { href: '/devices', label: 'Attendance machines', icon: 'fingerprint', cap: 'tenants:read' },
  { href: '/features', label: 'Feature management', icon: 'toggle', cap: 'tenants:read' },
  { href: '/plans', label: 'Plans & pricing', icon: 'tag', cap: 'billing:read' },
  { href: '/billing', label: 'Billing & revenue', icon: 'receipt', cap: 'billing:read' },
  { href: '/statutory-packs', label: 'Payroll country packs', icon: 'globe', cap: 'tenants:read' },
  { href: '/integrations', label: 'Integrations', icon: 'plug', cap: 'health:read' },
  { href: '/health', label: 'System health', icon: 'activity', cap: 'health:read' },
  { href: '/password-resets', label: 'Password resets', icon: 'key', cap: 'audit:read' },
  { href: '/audit', label: 'Platform audit', icon: 'scroll', cap: 'audit:read' },
  { href: '/admins', label: 'Console admins', icon: 'shield', cap: 'admins:manage' },
  // Help & Support: the Console's own help, the queries that reach SampCrew Support, and the content every level sees.
  { href: '/help-queries', label: 'Help queries', icon: 'ticket', cap: 'help:answer' },
  { href: '/help-content', label: 'Help content', icon: 'book', cap: 'help:manage' },
  { href: '/help', label: 'Help & Support', icon: 'lifebuoy' },
];

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const me = await load<Admin>('/platform/auth/me');
  // Every console page needs an MFA-verified session; the API enforces it too.
  if (!me.session.mfa) redirect('/enrol');
  // A temporary password set by another admin is replaced before anything else (the API refuses other actions too).
  if (me.mustChangePassword) redirect('/change-password');
  // The support inbox badge: unread messages from Super Workspaces. Live events refresh it (see LiveRefresh).
  const support = hasCap(me, 'support:chat') ? await load<{ unread: number }>('/platform/support/unread').catch(() => null) : null;
  // The help queries badge: queries waiting for SampCrew Support's first answer.
  const help = hasCap(me, 'help:answer') ? await load<{ waiting: number }>('/platform/help/queries/waiting').catch(() => null) : null;
  const nav = NAV.filter((n) => !n.cap || hasCap(me, n.cap)).map(({ cap: _c, ...n }) => (n.href === '/support' && support?.unread ? { ...n, badge: support.unread } : n.href === '/help-queries' && help?.waiting ? { ...n, badge: help.waiting } : n));
  return <Shell me={me} nav={nav} live={hasCap(me, 'support:chat')}>{children}</Shell>;
}
