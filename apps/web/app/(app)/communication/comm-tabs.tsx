import { cn } from '@crew/ui';
import Link from 'next/link';

const TABS = [
  { key: 'overview', href: '/communication', label: 'Overview', hr: true },
  { key: 'chat', href: '/communication/chat', label: 'Chat', hr: false },
  { key: 'emails', href: '/communication/emails', label: 'Emails', hr: false },
  { key: 'groups', href: '/communication/groups', label: 'Groups', hr: true },
  { key: 'requests', href: '/helpdesk', label: 'Help requests', hr: false },
  { key: 'support', href: '/support', label: 'SampCrew Support', hr: false },
] as const;

/**
 * The Communication sections. HR sees the overview and groups; help requests are Ask HR's cases (the queue for HR).
 * SampCrew Support (the private chat with the Console Admin team) is only for the Super Workspace.
 */
export function CommTabs({ active, isHr, unread, superWs, supportUnread }: { active: (typeof TABS)[number]['key']; isHr: boolean; unread?: number; superWs?: boolean; supportUnread?: number }) {
  return (
    <nav className="mb-5 flex flex-wrap gap-1 border-b border-border" aria-label="Communication">
      {TABS.filter((t) => (isHr || !t.hr) && (t.key !== 'support' || superWs)).map((t) => (
        <Link
          key={t.key}
          href={t.key === 'requests' && isHr ? '/helpdesk/queue' : t.href}
          aria-current={active === t.key ? 'page' : undefined}
          className={cn('-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[0.8125rem] font-medium', active === t.key ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg')}
        >
          {t.label}
          {t.key === 'chat' && !!unread && <span className="rounded-full bg-accent px-1.5 text-[0.625rem] font-semibold leading-4 text-accent-fg" data-testid="chat-unread">{unread}</span>}
          {t.key === 'support' && !!supportUnread && <span className="rounded-full bg-accent px-1.5 text-[0.625rem] font-semibold leading-4 text-accent-fg" data-testid="support-tab-unread">{supportUnread}</span>}
        </Link>
      ))}
    </nav>
  );
}
