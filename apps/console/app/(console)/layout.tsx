import { redirect } from 'next/navigation';
import type { ConsoleAlerts } from '@crew/contracts';
import { api, load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import type { Admin } from '@/lib/types';
import { Shell, type NavItem } from './shell';

const NAV: (NavItem & { cap?: string })[] = [
  { href: '/', label: 'Overview', icon: 'gauge', cap: 'tenants:read' },
  { href: '/tenants', label: 'Workspaces', icon: 'building', cap: 'tenants:read' },
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
];

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const me = await load<Admin>('/platform/auth/me');
  // Every console page needs an MFA-verified session; the API enforces it too.
  if (!me.session.mfa) redirect('/enrol');
  // A temporary password set by another admin is replaced before anything else (the API refuses other actions too).
  if (me.mustChangePassword) redirect('/change-password');
  const nav = NAV.filter((n) => !n.cap || hasCap(me, n.cap)).map(({ cap: _c, ...n }) => n);
  // System alerts for the bell and the menu markers (admins who can see workspaces).
  const alerts = hasCap(me, 'tenants:read') ? await api<ConsoleAlerts>('/platform/alerts').catch(() => null) : null;
  return <Shell me={me} nav={nav} alerts={alerts}>{children}</Shell>;
}
