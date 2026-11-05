import type { Me } from './types';

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  /** Visible when the user holds this permission (any scope). */
  permission?: string;
  /** Visible when the plan includes this feature. */
  feature?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    label: 'Workspace',
    items: [
      { href: '/', label: 'Home', icon: 'home' },
      { href: '/approvals', label: 'Approvals', icon: 'inbox' },
      { href: '/leave', label: 'Leave', icon: 'calendar', permission: 'leave:request' },
      { href: '/tasks', label: 'My tasks', icon: 'list-checks' },
    ],
  },
  {
    label: 'Organization',
    items: [
      { href: '/employees', label: 'Employees', icon: 'contact', permission: 'employees:read' },
      { href: '/people', label: 'Logins & access', icon: 'users', permission: 'users:read' },
      { href: '/organization', label: 'Structure', icon: 'building', permission: 'org:read' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { href: '/settings/leave', label: 'Leave settings', icon: 'sliders', permission: 'leave:configure' },
      { href: '/settings/onboarding', label: 'Onboarding checklists', icon: 'list-checks', permission: 'employees:create' },
      { href: '/settings/roles', label: 'Roles & permissions', icon: 'shield', permission: 'roles:read' },
      { href: '/settings/audit', label: 'Audit trail', icon: 'scroll', permission: 'audit:read' },
      { href: '/settings/billing', label: 'Plan & billing', icon: 'credit-card', permission: 'billing:read' },
      { href: '/settings/workspace', label: 'Workspace settings', icon: 'settings', permission: 'tenant:read' },
      { href: '/settings/support', label: 'Support access', icon: 'life-buoy', permission: 'tenant:read' },
    ],
  },
  { label: 'You', items: [{ href: '/settings/security', label: 'Security', icon: 'key' }] },
];

export function visibleNav(me: Me): NavGroup[] {
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => (!i.permission || me.permissions[i.permission]) && (!i.feature || me.features.includes(i.feature))) })).filter((g) => g.items.length);
}

export const can = (me: Me, permission: string) => Boolean(me.permissions[permission]);
