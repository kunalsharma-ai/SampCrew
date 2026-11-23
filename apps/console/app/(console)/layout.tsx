import { redirect } from 'next/navigation';
import type { ConsoleAlerts, ConsoleNotificationSummary, ConsoleSettings } from '@crew/contracts';
import { api, load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import type { Admin } from '@/lib/types';
import { Shell, type NavGroup } from './shell';

/**
 * The Console menu in groups: what is happening, the clients, revenue, support, security and the platform itself.
 * Each entry needs a permission; entries the admin's role cannot open are left out (the API refuses them too).
 */
const NAV: (Omit<NavGroup, 'items'> & { items: (NavGroup['items'][number] & { cap?: string })[] })[] = [
  { label: 'Overview', items: [
    { href: '/', label: 'Command center', icon: 'gauge', cap: 'tenants:read' },
    { href: '/notifications', label: 'Notifications', icon: 'bell' },
    { href: '/reports', label: 'Reports', icon: 'chart', cap: 'reports:read' },
  ] },
  { label: 'Clients', items: [
    { href: '/clients', label: 'Clients', icon: 'briefcase', cap: 'tenants:read' },
    { href: '/tenants', label: 'Super Workspaces', icon: 'building', cap: 'tenants:read' },
    { href: '/users', label: 'All users', icon: 'users', cap: 'access:manage' },
    { href: '/features', label: 'Feature management', icon: 'toggle', cap: 'tenants:read' },
    { href: '/devices', label: 'Attendance machines', icon: 'fingerprint', cap: 'tenants:read' },
  ] },
  { label: 'Revenue', items: [
    { href: '/plans', label: 'Plans & pricing', icon: 'tag', cap: 'billing:read' },
    { href: '/billing', label: 'Billing & revenue', icon: 'receipt', cap: 'billing:read' },
  ] },
  { label: 'Support', items: [
    { href: '/support', label: 'Support inbox', icon: 'headset', cap: 'support:chat' },
    { href: '/help-queries', label: 'Help queries', icon: 'ticket', cap: 'help:answer' },
    { href: '/help-content', label: 'Help content', icon: 'book', cap: 'help:manage' },
  ] },
  { label: 'Security', items: [
    { href: '/security', label: 'Security', icon: 'lock', cap: 'security:manage' },
    { href: '/audit', label: 'Audit log', icon: 'scroll', cap: 'audit:read' },
    { href: '/password-resets', label: 'Password resets', icon: 'key', cap: 'audit:read' },
    { href: '/admins', label: 'Console admins', icon: 'shield', cap: 'admins:manage' },
    { href: '/roles', label: 'Roles & permissions', icon: 'shieldCheck', cap: 'admins:manage' },
  ] },
  { label: 'Platform', items: [
    { href: '/health', label: 'System health', icon: 'activity', cap: 'health:read' },
    { href: '/integrations', label: 'Integrations', icon: 'plug', cap: 'health:read' },
    { href: '/statutory-packs', label: 'Payroll country packs', icon: 'globe', cap: 'tenants:read' },
    { href: '/settings', label: 'Settings', icon: 'settings', cap: 'tenants:read' },
    { href: '/help', label: 'Help & Support', icon: 'lifebuoy' },
  ] },
];

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const me = await load<Admin>('/platform/auth/me');
  // Every console page needs an MFA-verified session; the API enforces it too.
  if (!me.session.mfa) redirect('/enrol');
  // A temporary password set by another admin is replaced before anything else (the API refuses other actions too).
  if (me.mustChangePassword) redirect('/change-password');
  const [support, help, alerts, summary, settings] = await Promise.all([
    // The support inbox badge: unread messages from Super Workspaces.
    hasCap(me, 'support:chat') ? api<{ unread: number }>('/platform/support/unread').catch(() => null) : null,
    // The help queries badge: queries waiting for SampCrew Support's first answer.
    hasCap(me, 'help:answer') ? api<{ waiting: number }>('/platform/help/queries/waiting').catch(() => null) : null,
    // System alerts for the bell (admins who can see workspaces).
    hasCap(me, 'tenants:read') ? api<ConsoleAlerts>('/platform/alerts').catch(() => null) : null,
    api<ConsoleNotificationSummary>('/platform/notifications/summary').catch(() => null),
    // Branding from Console > Settings (name, accent colour, support email).
    hasCap(me, 'tenants:read') ? api<ConsoleSettings>('/platform/settings').catch(() => null) : null,
  ]);
  const nav: NavGroup[] = NAV.map((g) => ({
    label: g.label,
    items: g.items.filter((n) => !n.cap || hasCap(me, n.cap)).map(({ cap: _c, ...n }) => (n.href === '/support' && support?.unread ? { ...n, badge: support.unread } : n.href === '/help-queries' && help?.waiting ? { ...n, badge: help.waiting } : n)),
  })).filter((g) => g.items.length);
  return <Shell me={me} nav={nav} alerts={alerts} summary={summary} live={hasCap(me, 'support:chat')} branding={settings?.branding ?? null}>{children}</Shell>;
}
