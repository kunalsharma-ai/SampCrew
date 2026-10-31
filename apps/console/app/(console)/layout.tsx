import { redirect } from 'next/navigation';
import { load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import type { Admin } from '@/lib/types';
import { Shell, type NavItem } from './shell';

const NAV: (NavItem & { cap?: string })[] = [
  { href: '/', label: 'Overview', icon: 'gauge', cap: 'tenants:read' },
  { href: '/tenants', label: 'Tenants', icon: 'building', cap: 'tenants:read' },
  { href: '/plans', label: 'Plans & pricing', icon: 'tag', cap: 'billing:read' },
  { href: '/health', label: 'System health', icon: 'activity', cap: 'health:read' },
  { href: '/audit', label: 'Platform audit', icon: 'scroll', cap: 'audit:read' },
  { href: '/admins', label: 'Console admins', icon: 'shield', cap: 'admins:manage' },
];

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const me = await load<Admin>('/platform/auth/me');
  // Every console page needs an MFA-verified session; the API enforces it too.
  if (!me.session.mfa) redirect('/enrol');
  const nav = NAV.filter((n) => !n.cap || hasCap(me, n.cap)).map(({ cap: _c, ...n }) => n);
  return <Shell me={me} nav={nav}>{children}</Shell>;
}
