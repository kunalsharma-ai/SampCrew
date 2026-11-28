import type { RequestKind } from '@crew/contracts';
import { REQUEST_KIND_DEFS } from '@crew/contracts';
import { cn } from '@crew/ui';
import { AlarmClock, Briefcase, CalendarPlus, CalendarX, Clock, House, LogOut, MessageSquarePlus, Plane, Repeat, type LucideIcon } from 'lucide-react';

export const KIND_ICONS: Record<RequestKind, LucideIcon> = {
  wfh: House, early_leave: LogOut, late_coming: AlarmClock, comp_off: CalendarPlus, leave: Plane, attendance_regularization: Clock, on_duty: Briefcase, shift_change: Repeat,
  other: MessageSquarePlus, leave_cancellation: CalendarX,
};

/**
 * The request type's icon on a raised, glossy tile (a soft 3D look: gradient body, light from the top, a coloured
 * shadow), the same on every screen that shows requests.
 */
export function KindTile({ kind, size = 'md', className }: { kind: RequestKind; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const Icon = KIND_ICONS[kind] ?? Plane;
  const color = REQUEST_KIND_DEFS[kind]?.color ?? '#2563eb';
  const box = size === 'lg' ? 'size-14 rounded-2xl' : size === 'sm' ? 'size-8 rounded-lg' : 'size-11 rounded-xl';
  const icon = size === 'lg' ? 'size-7' : size === 'sm' ? 'size-4' : 'size-5';
  return (
    <span
      aria-hidden
      className={cn('relative inline-flex shrink-0 items-center justify-center text-white', box, className)}
      style={{
        background: `linear-gradient(145deg, color-mix(in srgb, ${color} 70%, white) 0%, ${color} 55%, color-mix(in srgb, ${color} 75%, black) 100%)`,
        boxShadow: `0 8px 18px -8px ${color}, inset 0 1px 0 rgb(255 255 255 / 0.45), inset 0 -2px 0 rgb(0 0 0 / 0.12)`,
      }}
    >
      <span className="pointer-events-none absolute inset-x-1 top-0.5 h-1/2 rounded-[inherit] bg-gradient-to-b from-white/35 to-transparent" />
      <Icon className={cn('relative drop-shadow-sm', icon)} strokeWidth={2.2} />
    </span>
  );
}

/** The hero illustration: a raised calendar card, a paper plane on its way and a check badge, drawn in SVG. */
export function RequestsIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 160" className={className} role="img" aria-label="A request flying to its approvers">
      <defs>
        <linearGradient id="rq-card" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#e9e7ff" /></linearGradient>
        <linearGradient id="rq-head" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#818cf8" /><stop offset="1" stopColor="#4f46e5" /></linearGradient>
        <linearGradient id="rq-plane" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fde68a" /><stop offset="1" stopColor="#f59e0b" /></linearGradient>
        <linearGradient id="rq-ok" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#6ee7b7" /><stop offset="1" stopColor="#059669" /></linearGradient>
        <filter id="rq-shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="8" stdDeviation="7" floodColor="#312e81" floodOpacity="0.28" /></filter>
      </defs>
      <ellipse cx="104" cy="146" rx="70" ry="7" fill="#312e81" opacity="0.12" />
      <g filter="url(#rq-shadow)" transform="rotate(-6 104 86)">
        <rect x="52" y="36" width="104" height="100" rx="14" fill="url(#rq-card)" />
        <rect x="52" y="36" width="104" height="28" rx="14" fill="url(#rq-head)" />
        <rect x="52" y="50" width="104" height="14" fill="url(#rq-head)" />
        <rect x="72" y="28" width="8" height="18" rx="4" fill="#3730a3" /><rect x="128" y="28" width="8" height="18" rx="4" fill="#3730a3" />
        {[0, 1, 2, 3].map((r) => [0, 1, 2, 3, 4].map((c) => (
          <rect key={`${r}-${c}`} x={64 + c * 17} y={74 + r * 14} width="11" height="8" rx="2.5" fill={r === 1 && c > 0 && c < 4 ? '#a5b4fc' : '#e0e7ff'} />
        )))}
      </g>
      <g filter="url(#rq-shadow)">
        <path d="M150 58 L222 26 L196 92 L178 74 Z" fill="url(#rq-plane)" />
        <path d="M178 74 L222 26 L170 66 Z" fill="#d97706" opacity="0.55" />
        <path d="M150 58 C 132 70, 120 74, 108 70" fill="none" stroke="#f59e0b" strokeWidth="2.5" strokeDasharray="4 6" strokeLinecap="round" opacity="0.7" />
      </g>
      <g filter="url(#rq-shadow)">
        <circle cx="160" cy="122" r="17" fill="url(#rq-ok)" />
        <path d="M152 122 l6 6 l11 -12" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Pending', cls: 'bg-warning-subtle text-warning ring-warning/30' },
  changes_requested: { label: 'Changes requested', cls: 'bg-info-subtle text-info ring-info/30' },
  not_needed: { label: 'Not needed', cls: 'bg-bg-subtle text-fg-muted ring-border' },
  approved: { label: 'Approved', cls: 'bg-success-subtle text-success ring-success/30' },
  rejected: { label: 'Rejected', cls: 'bg-danger-subtle text-danger ring-danger/30' },
  cancelled: { label: 'Cancelled', cls: 'bg-bg-subtle text-fg-muted ring-border' },
  waiting: { label: 'Waiting for turn', cls: 'bg-bg-subtle text-fg-muted ring-border' },
};

export function StatusChip({ status, className }: { status: string; className?: string }) {
  const s = STATUS[status] ?? STATUS.pending!;
  return <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold ring-1', s.cls, className)} data-testid="request-status">{s.label}</span>;
}
