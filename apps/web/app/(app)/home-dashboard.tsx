'use client';
import { resolveLayout, type DashboardLayout, type DashboardWidget } from '@crew/contracts';
import { Badge, Button, Card, CardBody, CardHeader, Textarea, buttonClass, cn } from '@crew/ui';
import {
  ArrowDown, ArrowDownRight, ArrowRight, ArrowUp, ArrowUpRight, CalendarClock, CheckCircle2, Circle, ClipboardCheck, Eye, EyeOff, GripVertical, History, Inbox,
  LayoutGrid, LifeBuoy, NotebookPen, Palette, ShieldCheck, Sparkles, UserCheck, Wallet, Zap, Bot, CalendarDays,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { ChartPanel, DonutChart, LineChart } from '@/components/neon';
import type { QuickAction } from '@/lib/nav';
import { decideApprovalAction, saveDashboardAction, saveNotesAction } from './experience-actions';
import { dateTime } from './helpdesk/labels';
import type { Announcement, Summary } from './helpdesk/types';
import { ICONS, useExperience } from './shell';

export interface Kpi { key: string; label: string; value: number | null; unit?: 'percent' | 'money'; currency?: string; hint?: string; trend?: number[]; delta?: number | null; href?: string }
export interface AttentionItem { key: string; kind: 'approval' | 'interview' | 'task' | 'probation' | 'payroll'; title: string; detail: string | null; at: string | null; href: string; approvalId?: string; overdue?: boolean }
export interface Dashboard {
  generatedAt: string;
  today: string;
  kpis: Kpi[];
  attention: AttentionItem[];
  counts: { approvals: number; tasks: number; interviews: number };
  departments: { id: string | null; name: string; count: number }[] | null;
  funnel: { stage: string; kind: string; count: number }[] | null;
  attendance: { rate: number | null; present: number; expected: number; late: number; onLeave: number; missing: number; absent: number } | null;
}

const WIDGET_LABEL: Record<DashboardWidget, string> = {
  attention: 'Needs your attention', announcements: 'Announcements', headcount: 'Workforce at a glance', tasks: 'My tasks', recent: 'Recently viewed',
  'quick-actions': 'Quick actions', notes: 'Personal notes', helpdesk: 'Ask HR', setup: 'Set up your workspace', access: 'Your access',
};
/** Widgets that read best at full width; the rest sit two to a row on wide screens. */
const WIDE: DashboardWidget[] = ['attention', 'headcount'];

export function HomeDashboard(props: {
  firstName: string;
  tenantName: string;
  welcome: boolean;
  dashboard: Dashboard | null;
  layout: DashboardLayout | null;
  notes: string;
  news: Announcement[] | null;
  helpdesk: Summary | null;
  steps: { done: boolean; label: string; href: string }[];
  roles: { key: string; name: string }[];
  access: { key: string; description: string; scope: string }[];
  plan: { name: string | null; status: string | null; included: number; total: number; maxEmployees: number; canView: boolean };
  actions: QuickAction[];
}) {
  const { dashboard: d } = props;
  const { openThemes, openAssistant } = useExperience();
  const [layout, setLayout] = useState(() => resolveLayout(props.layout));
  const [editing, setEditing] = useState(false);
  const [saving, startSaving] = useTransition();
  const [saved, setSaved] = useState<string | null>(null);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const available = (w: DashboardWidget) => {
    switch (w) {
      case 'announcements': return Boolean(props.news?.length);
      case 'helpdesk': return Boolean(props.helpdesk);
      case 'setup': return props.steps.length > 0;
      case 'headcount': return Boolean(d && (d.funnel || d.attendance));
      case 'attention': case 'tasks': return Boolean(d);
      default: return true;
    }
  };
  const visible = layout.order.filter((w) => available(w) && (editing || !layout.hidden.includes(w)));

  const move = (w: DashboardWidget, dir: -1 | 1) => {
    const order = [...layout.order];
    const i = order.indexOf(w);
    // Move past widgets that are not shown here, so one press always moves one visible place.
    let j = i + dir;
    while (j >= 0 && j < order.length && !visible.includes(order[j]!)) j += dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    setLayout({ ...layout, order });
  };
  const drop = (dragged: DashboardWidget, target: DashboardWidget) => {
    if (dragged === target) return;
    const order = layout.order.filter((w) => w !== dragged);
    order.splice(order.indexOf(target), 0, dragged);
    setLayout({ ...layout, order });
  };
  const toggleHidden = (w: DashboardWidget) => setLayout({ ...layout, hidden: layout.hidden.includes(w) ? layout.hidden.filter((x) => x !== w) : [...layout.hidden, w] });
  const save = () => startSaving(async () => {
    const r = await saveDashboardAction(layout);
    setSaved(r.ok ? 'Layout saved' : r.message);
    if (r.ok) setEditing(false);
  });
  const dragging = useRef<DashboardWidget | null>(null);

  const render = (w: DashboardWidget) => {
    switch (w) {
      case 'attention': return <AttentionWidget items={d!.attention} />;
      case 'announcements': return <AnnouncementsWidget news={props.news!} />;
      case 'headcount': return <WorkforceWidget d={d!} />;
      case 'tasks': return <TasksWidget items={d!.attention.filter((a) => a.kind === 'task' || a.kind === 'interview')} />;
      case 'recent': return <RecentWidget />;
      case 'quick-actions': return <QuickActionsWidget actions={props.actions} />;
      case 'notes': return <NotesWidget initial={props.notes} />;
      case 'helpdesk': return <HelpdeskWidget s={props.helpdesk!} />;
      case 'setup': return <SetupWidget steps={props.steps} />;
      case 'access': return <AccessWidget roles={props.roles} access={props.access} plan={props.plan} />;
    }
  };

  return (
    <>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between animate-fade-in">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-accent">
            {props.tenantName}
            {d && <span className="inline-flex items-center gap-1 rounded-full bg-success-subtle px-2 py-0.5 text-[0.625rem] normal-case tracking-normal text-success"><span className="size-1.5 rounded-full bg-success" aria-hidden /> Live, updated {new Date(d.generatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>}
          </div>
          <h1 className="crew-hero-title text-2xl font-semibold tracking-tight text-fg">{props.welcome ? `Welcome to CREW, ${props.firstName}` : <><span aria-hidden>👋 </span>{greeting}, <span className="crew-gradient-text">{props.firstName}!</span></>}</h1>
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">
            {props.welcome ? 'Your workspace is ready. Start by shaping your organization, then invite your team.' : d?.attention.length ? `${d.attention.length} item${d.attention.length === 1 ? '' : 's'} need${d.attention.length === 1 ? 's' : ''} you today.` : 'You are all caught up. Here is where your workspace stands today.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {d && <span className="crew-card inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-[0.75rem] font-medium text-fg-muted"><CalendarDays className="size-3.5" aria-hidden />{new Date(`${d.today}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span>}
          {!editing && <Button variant="secondary" size="sm" onClick={openThemes}><Palette className="size-3.5" /> Themes</Button>}
          {saved && !editing && <span className="text-xs text-fg-subtle" role="status">{saved}</span>}
          {editing ? (
            <>
              <Button variant="secondary" size="sm" onClick={() => { setLayout(resolveLayout(props.layout)); setEditing(false); }}>Cancel</Button>
              <Button size="sm" onClick={save} loading={saving}>Save layout</Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => { setSaved(null); setEditing(true); }}><LayoutGrid className="size-3.5" /> Customize</Button>
          )}
        </div>
      </div>

      {d && d.kpis.length > 0 && <KpiStrip kpis={d.kpis} />}
      {d && <Spotlight d={d} actions={props.actions} openAssistant={openAssistant} />}
      {!d && <Card className="mb-6 p-5 text-[0.8125rem] text-fg-muted">The dashboard could not load just now. Your pages in the menu still work.</Card>}

      {editing && <p className="mb-3 text-[0.8125rem] text-fg-muted">Drag widgets to reorder them, or use the arrow buttons. Hidden widgets stay here while you edit.</p>}
      <div className="grid gap-5 xl:grid-cols-2">
        {visible.map((w) => (
          <section
            key={w}
            aria-label={WIDGET_LABEL[w]}
            className={cn(WIDE.includes(w) && 'xl:col-span-2', editing && 'rounded-xl outline-2 outline-dashed outline-offset-4 outline-border-strong', editing && layout.hidden.includes(w) && 'opacity-50')}
            draggable={editing}
            onDragStart={() => { dragging.current = w; }}
            onDragOver={(e) => editing && e.preventDefault()}
            onDrop={() => dragging.current && drop(dragging.current, w)}
          >
            {editing && (
              <div className="mb-2 flex items-center gap-1 text-[0.8125rem]">
                <GripVertical className="size-4 cursor-grab text-fg-subtle" aria-hidden />
                <span className="flex-1 font-medium">{WIDGET_LABEL[w]}</span>
                <button type="button" className="rounded p-1 hover:bg-bg-subtle" onClick={() => move(w, -1)} aria-label={`Move ${WIDGET_LABEL[w]} up`}><ArrowUp className="size-3.5" /></button>
                <button type="button" className="rounded p-1 hover:bg-bg-subtle" onClick={() => move(w, 1)} aria-label={`Move ${WIDGET_LABEL[w]} down`}><ArrowDown className="size-3.5" /></button>
                <button type="button" className="rounded p-1 hover:bg-bg-subtle" onClick={() => toggleHidden(w)} aria-label={layout.hidden.includes(w) ? `Show ${WIDGET_LABEL[w]}` : `Hide ${WIDGET_LABEL[w]}`}>
                  {layout.hidden.includes(w) ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                </button>
              </div>
            )}
            {render(w)}
          </section>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------------------------------------------

function useCountUp(target: number | null) {
  const [v, setV] = useState(target ?? 0);
  useEffect(() => {
    if (target === null) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'focus';
    if (reduce) { setV(target); return; }
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / 600);
      setV(target * (1 - (1 - p) ** 3));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return v;
}

function formatKpi(k: Kpi, v: number) {
  if (k.value === null) return '—';
  if (k.unit === 'percent') return `${v.toFixed(1)}%`;
  if (k.unit === 'money') return new Intl.NumberFormat(undefined, { style: 'currency', currency: k.currency ?? 'INR', notation: 'compact', maximumFractionDigits: 1 }).format(v);
  return Math.round(v).toLocaleString();
}

const TONES = ['violet', 'teal', 'orange', 'blue', 'pink', 'green'] as const;
const KPI_ICON: Record<string, string> = {
  headcount: 'users', active: 'contact', 'new-hires': 'user-plus', attrition: 'trending-down', 'open-positions': 'briefcase', pipeline: 'user-search',
  attendance: 'fingerprint', approvals: 'inbox', payroll: 'wallet',
};

function KpiCard({ k, tone }: { k: Kpi; tone: (typeof TONES)[number] }) {
  const v = useCountUp(k.value);
  const Icon = ICONS[KPI_ICON[k.key] ?? 'chart'] ?? Sparkles;
  const bad = k.key === 'attrition';
  const inner = (
    <>
      <div className="relative flex items-start gap-3">
        <span className="crew-tile-icon flex size-10 shrink-0 items-center justify-center rounded-xl"><Icon className="size-5" aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[1.6rem] font-bold leading-tight tabular">{formatKpi(k, v)}</div>
          <div className="crew-tile-muted truncate text-[0.8125rem] font-medium">{k.label}</div>
        </div>
      </div>
      <div className="relative mt-2 flex min-h-5 items-center justify-between gap-2 text-[0.6875rem]">
        <span className="crew-tile-muted truncate">{k.hint}</span>
        {typeof k.delta === 'number' && k.delta !== 0 && (
          <span className="crew-tile-chip inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 font-semibold tabular" aria-label={`Change ${k.delta > 0 ? '+' : ''}${k.delta}${(k.delta > 0) !== bad ? ', better' : ', worse'}`}>
            {k.delta > 0 ? <ArrowUpRight className="size-3" aria-hidden /> : <ArrowDownRight className="size-3" aria-hidden />}{k.delta > 0 ? '+' : ''}{k.delta}
          </span>
        )}
      </div>
    </>
  );
  const cls = cn('crew-tile group block p-4 transition-transform duration-150', `crew-tile-${tone}`, k.href && 'hover:-translate-y-0.5');
  // Label first for screen readers ("Pending approvals 3, waiting for you"), whatever the visual order.
  const name = `${k.label} ${formatKpi(k, k.value ?? 0)}${k.hint ? `, ${k.hint}` : ''}`;
  return k.href ? <Link href={k.href} className={cls} title={k.hint} aria-label={name}>{inner}</Link> : <div className={cls} role="group" aria-label={name}>{inner}</div>;
}

function KpiStrip({ kpis }: { kpis: Kpi[] }) {
  return (
    <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Key figures">
      {kpis.map((k, i) => <KpiCard key={k.key} k={k} tone={TONES[i % TONES.length]!} />)}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Spotlight: workforce trend, departments, today's highlights and the assistant (the neon Home layout)
// ---------------------------------------------------------------------------------------------------------------

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function Spotlight({ d, actions, openAssistant }: { d: Dashboard; actions: QuickAction[]; openAssistant: (() => void) | null }) {
  const head = d.kpis.find((k) => k.key === 'headcount');
  const m = Number(d.today.slice(5, 7)) - 1;
  const trend = head?.trend?.map((value, i, all) => ({ label: MONTH[(m - (all.length - 1 - i) + 120) % 12]!, value })) ?? [];
  const total = d.departments?.reduce((t, x) => t + x.count, 0) ?? 0;
  const top = d.departments?.slice(0, 5) ?? [];
  const rest = total - top.reduce((t, x) => t + x.count, 0);
  const slices = [...top.map((x) => ({ label: x.name, value: x.count, href: x.id ? `/employees?departmentId=${x.id}` : undefined })), ...(rest > 0 ? [{ label: 'Others', value: rest }] : [])];
  const highlights = [
    { label: 'Pending approvals', value: d.counts.approvals, href: '/approvals', icon: Inbox, tone: 'text-accent' },
    ...(d.attendance ? [{ label: 'Attendance exceptions', value: d.attendance.missing + d.attendance.absent, href: '/attendance/team?status=missing_punch', icon: Zap, tone: 'text-danger' }] : []),
    { label: 'Interviews this week', value: d.counts.interviews, href: '/recruitment/interviews', icon: CalendarClock, tone: 'text-info' },
    { label: 'Open tasks', value: d.counts.tasks, href: '/tasks', icon: ClipboardCheck, tone: 'text-success' },
  ];
  return (
    <div className="mb-6 grid gap-5">
      {(trend.length > 1 || slices.length > 0) && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          {trend.length > 1 && head && (
            <ChartPanel title="Workforce overview" action={<span className="text-[0.75rem] text-fg-subtle">{head.value} now{typeof head.delta === 'number' ? `, ${head.delta >= 0 ? '+' : ''}${head.delta} in 6 months` : ''}</span>}>
              <LineChart points={trend} />
            </ChartPanel>
          )}
          {slices.length > 0 && (
            <ChartPanel title="Department wise employees" action={<Link href="/employees" className="text-[0.75rem] font-medium text-accent hover:underline">Employees</Link>}>
              <DonutChart slices={slices} centerValue={String(total)} centerLabel="Employees" />
            </ChartPanel>
          )}
        </div>
      )}
      <div className={cn('grid gap-5', openAssistant ? 'lg:grid-cols-3' : 'lg:grid-cols-2')}>
        <ChartPanel title="Today's highlights" action={<Link href="/approvals" className="inline-flex items-center gap-1 text-[0.75rem] font-medium text-accent hover:underline">View all <ArrowRight className="size-3" aria-hidden /></Link>}>
          <ul className="divide-y divide-border">
            {highlights.map((h) => (
              <li key={h.label}>
                <Link href={h.href} className="flex items-center gap-3 py-2 text-[0.8125rem] hover:text-accent">
                  <h.icon className={cn('size-4 shrink-0', h.tone)} aria-hidden />
                  <span className="w-6 font-bold tabular">{h.value}</span>
                  <span className="min-w-0 flex-1 truncate">{h.label}</span>
                  <ArrowRight className="size-3.5 text-fg-subtle" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </ChartPanel>
        <ChartPanel title="Quick actions">
          <div className="grid grid-cols-2 gap-2">
            {actions.slice(0, 4).map((a, i) => {
              const Icon = ICONS[a.icon] ?? ArrowRight;
              return (
                <Link key={a.key} href={a.href} className="flex flex-col items-start gap-2 rounded-xl border border-border bg-bg-subtle/60 p-3 text-[0.8125rem] font-medium transition-colors hover:border-accent hover:text-accent">
                  <span className={cn('crew-tile flex size-8 items-center justify-center rounded-lg', `crew-tile-${TONES[i % TONES.length]}`)}><Icon className="size-4" aria-hidden /></span>
                  <span className="line-clamp-2">{a.label}</span>
                </Link>
              );
            })}
            {!actions.length && <p className="col-span-2 text-[0.8125rem] text-fg-muted">Nothing to create with your access.</p>}
          </div>
        </ChartPanel>
        {openAssistant && (
          <div className="crew-ai-card relative flex flex-col justify-between gap-4 overflow-hidden rounded-xl p-5 shadow-pop">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-bold"><Bot className="size-5" aria-hidden /> CREW IQ</h2>
              <p className="mt-1 text-[0.8125rem] text-[#e4defc]">Your AI HR assistant. Ask about leave, attendance, hiring or your team, and get answers from your live records.</p>
            </div>
            <button type="button" onClick={openAssistant} className="inline-flex w-fit items-center gap-2 rounded-full bg-white px-4 py-2 text-[0.8125rem] font-semibold text-[#2a1a66] shadow-card hover:bg-[#f1ecff]">
              Ask anything <Sparkles className="size-4" aria-hidden />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------------------------------------------

const KIND: Record<AttentionItem['kind'], { label: string; icon: typeof Inbox; tone: 'accent' | 'info' | 'warning' | 'neutral' | 'success' }> = {
  approval: { label: 'Approval', icon: Inbox, tone: 'accent' },
  interview: { label: 'Interview', icon: CalendarClock, tone: 'info' },
  task: { label: 'Task', icon: ClipboardCheck, tone: 'neutral' },
  probation: { label: 'Probation', icon: UserCheck, tone: 'warning' },
  payroll: { label: 'Payroll', icon: Wallet, tone: 'success' },
};

const when = (iso: string | null) => {
  if (!iso) return null;
  return iso.length === 10 ? new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

function AttentionWidget({ items }: { items: AttentionItem[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<AttentionItem['kind'] | 'all'>('all');
  const kinds = [...new Set(items.map((i) => i.kind))];
  const shown = items.filter((i) => filter === 'all' || i.kind === filter);
  const decide = async (item: AttentionItem, decision: 'approve' | 'reject') => {
    setBusy(item.key);
    setError(null);
    const r = await decideApprovalAction(item.approvalId!, decision);
    setBusy(null);
    if (!r.ok) { setError(r.message ?? 'That did not work'); return; }
    setDone((x) => ({ ...x, [item.key]: decision === 'approve' ? 'Approved' : 'Rejected' }));
    router.refresh();
  };
  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-2"><Zap className="size-4 text-accent" /> Needs your attention</span>}
        description={items.length ? `${items.length} open item${items.length === 1 ? '' : 's'}` : 'Nothing is waiting for you'}
        action={kinds.length > 1 && (
          <div className="flex flex-wrap gap-1" role="group" aria-label="Filter items">
            {(['all', ...kinds] as const).map((k) => (
              <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)} className={cn('rounded-full px-2.5 py-0.5 text-[0.6875rem] font-medium', filter === k ? 'bg-accent text-accent-fg' : 'bg-bg-subtle text-fg-muted hover:text-fg')}>
                {k === 'all' ? 'All' : KIND[k].label}
              </button>
            ))}
          </div>
        )}
      />
      {error && <p className="px-5 pb-2 text-[0.8125rem] text-danger" role="alert">{error}</p>}
      {shown.length === 0 ? (
        <div className="flex items-center gap-3 px-5 pb-5 text-[0.8125rem] text-fg-muted"><CheckCircle2 className="size-5 text-success" /> You are all caught up.</div>
      ) : (
        <ul className="divide-y divide-border" aria-label="Items that need your attention">
          {shown.map((i) => {
            const k = KIND[i.kind];
            return (
              <li key={i.key} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
                <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', i.kind === 'approval' ? 'bg-accent-subtle text-accent' : 'bg-bg-subtle text-fg-muted')}><k.icon className="size-4" aria-hidden /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link href={i.href} className="truncate text-[0.8125rem] font-medium hover:text-accent hover:underline">{i.title}</Link>
                    {i.overdue && <Badge tone="danger">Overdue</Badge>}
                  </div>
                  <div className="truncate text-[0.75rem] text-fg-subtle"><span className="font-medium text-fg-muted">{k.label}</span>{i.detail ? ` · ${i.detail}` : ''}{i.at ? ` · ${when(i.at)}` : ''}</div>
                </div>
                {done[i.key] ? (
                  <Badge tone="success">{done[i.key]}</Badge>
                ) : i.kind === 'approval' ? (
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void decide(i, 'reject')} aria-label={`Reject: ${i.title}`}>Reject</Button>
                    <Button size="sm" loading={busy === i.key} disabled={busy !== null && busy !== i.key} onClick={() => void decide(i, 'approve')} aria-label={`Approve: ${i.title}`}>Approve</Button>
                  </div>
                ) : (
                  <Link href={i.href} className={buttonClass('secondary', 'sm')}>Open</Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function AnnouncementsWidget({ news }: { news: Announcement[] }) {
  const unread = news.filter((a) => !a.readAt || (a.requiresAck && !a.acknowledgedAt));
  return (
    <Card className="h-full">
      <CardHeader title="Announcements" description={unread.length ? `${unread.length} need your attention` : 'You are up to date'} action={<Link href="/announcements" className={buttonClass('secondary', 'sm')}>All</Link>} />
      <ul className="divide-y divide-border">
        {news.slice(0, 4).map((a) => (
          <li key={a.id} className="flex items-center gap-2 px-5 py-2.5 text-[0.8125rem]">
            <Link href={`/announcements/${a.id}`} className="min-w-0 flex-1 truncate font-medium hover:text-accent hover:underline">{a.title}</Link>
            {a.requiresAck && !a.acknowledgedAt ? <Badge tone="warning">Please acknowledge</Badge> : !a.readAt ? <Badge tone="info">New</Badge> : null}
            <span className="shrink-0 text-xs text-fg-subtle">{a.publishedAt && dateTime(a.publishedAt)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Bars({ rows, label }: { rows: { name: string; count: number; href?: string }[]; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className="flex flex-col gap-2" aria-label={label}>
      {rows.map((r, i) => (
        <li key={`${r.name}-${i}`} className="grid grid-cols-[minmax(0,9rem)_1fr_2.5rem] items-center gap-3 text-[0.8125rem]">
          <span className="truncate text-fg-muted" title={r.name}>{r.name}</span>
          <span className="h-2.5 overflow-hidden rounded-full bg-bg-subtle"><span className="block h-full rounded-full bg-gradient-to-r from-chart-1 to-chart-2 transition-[width] duration-500" style={{ width: `${(r.count / max) * 100}%` }} /></span>
          <span className="text-right font-medium tabular">{r.count}</span>
        </li>
      ))}
    </ul>
  );
}

function WorkforceWidget({ d }: { d: Dashboard }) {
  const a = d.attendance;
  const segments = a ? [
    { key: 'present', label: 'In', value: a.present, cls: 'bg-success' },
    { key: 'missing', label: 'Missing punch', value: a.missing, cls: 'bg-warning' },
    { key: 'absent', label: 'Absent', value: a.absent, cls: 'bg-danger' },
    { key: 'leave', label: 'On leave', value: a.onLeave, cls: 'bg-info' },
  ] : [];
  const total = segments.reduce((t, s) => t + s.value, 0);
  return (
    <Card>
      <CardHeader title="Workforce at a glance" description="Live from your records, limited to the people you can see." />
      <CardBody className="grid gap-6 pt-1 lg:grid-cols-2">
        {d.funnel && (
          <div>
            <div className="mb-3 flex items-center justify-between text-[0.75rem] font-semibold uppercase tracking-wider text-fg-subtle">Recruitment pipeline <Link href="/recruitment/candidates" className="normal-case tracking-normal text-accent hover:underline">Candidates</Link></div>
            <Bars rows={d.funnel.map((f) => ({ name: f.stage, count: f.count }))} label="Active applications by stage" />
          </div>
        )}
        {a && (
          <div>
            <div className="mb-3 flex items-center justify-between text-[0.75rem] font-semibold uppercase tracking-wider text-fg-subtle">Attendance today <Link href="/attendance/team" className="normal-case tracking-normal text-accent hover:underline">Team</Link></div>
            {a.expected > 0 ? (
              <>
                <div className="mb-3 flex h-3 overflow-hidden rounded-full bg-bg-subtle" role="img" aria-label={segments.map((s) => `${s.label} ${s.value}`).join(', ')}>
                  {segments.map((s) => s.value > 0 && <span key={s.key} className={cn('h-full', s.cls)} style={{ width: `${(s.value / Math.max(1, total)) * 100}%` }} />)}
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[0.8125rem]">
                  {segments.map((s) => (
                    <div key={s.key} className="flex items-center justify-between gap-2"><dt className="flex items-center gap-1.5 text-fg-muted"><span className={cn('size-2 rounded-sm', s.cls)} aria-hidden />{s.label}</dt><dd className="font-medium tabular">{s.value}</dd></div>
                  ))}
                  <div className="flex items-center justify-between gap-2"><dt className="text-fg-muted">Late</dt><dd className="font-medium tabular">{a.late}</dd></div>
                </dl>
              </>
            ) : <p className="text-[0.8125rem] text-fg-muted">Nobody is expected at work today (holiday, weekly off or leave).</p>}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function TasksWidget({ items }: { items: AttentionItem[] }) {
  return (
    <Card className="h-full">
      <CardHeader title="My tasks" description={items.length ? `${items.length} coming up` : 'No open tasks or interviews'} action={<Link href="/tasks" className={buttonClass('secondary', 'sm')}>All tasks</Link>} />
      <ul className="divide-y divide-border pb-1">
        {items.slice(0, 6).map((i) => (
          <li key={i.key} className="flex items-center gap-3 px-5 py-2 text-[0.8125rem]">
            {i.kind === 'interview' ? <CalendarClock className="size-4 text-info" aria-label="Interview" /> : <Circle className="size-4 text-fg-subtle" aria-label="Task" />}
            <Link href={i.href} className="min-w-0 flex-1 truncate hover:text-accent hover:underline">{i.title}</Link>
            {i.at && <span className={cn('shrink-0 text-xs', i.overdue ? 'text-danger' : 'text-fg-subtle')}>{when(i.at)}</span>}
          </li>
        ))}
        {!items.length && <li className="px-5 pb-4 text-[0.8125rem] text-fg-muted">When someone assigns you an onboarding task or an interview, it appears here.</li>}
      </ul>
    </Card>
  );
}

function RecentWidget() {
  const { recents } = useExperience();
  return (
    <Card className="h-full">
      <CardHeader title={<span className="flex items-center gap-2"><History className="size-4 text-accent" /> Recently viewed</span>} />
      <ul className="flex flex-col pb-3">
        {recents.slice(0, 6).map((r) => (
          <li key={r.href}><Link href={r.href} className="flex items-center gap-3 px-5 py-1.5 text-[0.8125rem] hover:bg-bg-subtle"><span className="min-w-0 flex-1 truncate">{r.label}</span><span className="shrink-0 text-xs text-fg-subtle">{when(r.at)}</span></Link></li>
        ))}
        {!recents.length && <li className="px-5 pb-2 text-[0.8125rem] text-fg-muted">Pages you open appear here, on any device you sign in on.</li>}
      </ul>
    </Card>
  );
}

function QuickActionsWidget({ actions }: { actions: QuickAction[] }) {
  return (
    <Card className="h-full">
      <CardHeader title={<span className="flex items-center gap-2"><Sparkles className="size-4 text-accent" /> Quick actions</span>} description="Press Ctrl K anywhere for more." />
      <CardBody className="grid grid-cols-2 gap-2 pt-1">
        {actions.slice(0, 8).map((a) => {
          const Icon = ICONS[a.icon] ?? ArrowRight;
          return (
            <Link key={a.key} href={a.href} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[0.8125rem] text-fg-muted transition-colors hover:border-accent hover:text-fg">
              <Icon className="size-4 shrink-0 text-accent" aria-hidden /> <span className="truncate">{a.label}</span>
            </Link>
          );
        })}
      </CardBody>
    </Card>
  );
}

function NotesWidget({ initial }: { initial: string }) {
  const [notes, setNotes] = useState(initial);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const last = useRef(initial);
  // Saves a second after typing stops, and again when leaving the field.
  useEffect(() => {
    if (notes === last.current) return;
    const t = setTimeout(() => save(notes), 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);
  const save = (value: string) => start(async () => {
    if (value === last.current) return;
    const r = await saveNotesAction(value);
    if (r.ok) { last.current = value; setStatus(`Saved ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`); } else setStatus(r.message ?? 'Not saved');
  });
  return (
    <Card className="h-full">
      <CardHeader title={<span className="flex items-center gap-2"><NotebookPen className="size-4 text-accent" /> Personal notes</span>} description="Only you can see these." action={<span className="text-xs text-fg-subtle" role="status">{pending ? 'Saving…' : status}</span>} />
      <CardBody className="pt-1">
        <Textarea aria-label="Your notes" value={notes} maxLength={4000} rows={5} onChange={(e) => setNotes(e.target.value)} onBlur={() => save(notes)} placeholder="Reminders, follow-ups, things to raise in the next one-to-one…" />
      </CardBody>
    </Card>
  );
}

function HelpdeskWidget({ s }: { s: Summary }) {
  return (
    <Card className="h-full">
      <CardHeader title="Ask HR" action={<LifeBuoy className="size-5 text-accent" />} />
      <CardBody className="grid gap-2 text-[0.8125rem]">
        <div className="flex justify-between"><span className="text-fg-muted">Your open questions</span><span className="font-medium tabular-nums">{s.mine.open + s.mine.waiting}</span></div>
        {s.mine.waiting > 0 && <div className="flex justify-between"><span className="text-warning">Waiting for your reply</span><span className="font-medium tabular-nums">{s.mine.waiting}</span></div>}
        {s.mine.resolved > 0 && <div className="flex justify-between"><span className="text-fg-muted">Resolved, please confirm</span><span className="font-medium tabular-nums">{s.mine.resolved}</span></div>}
        {s.assignedToMe !== null && <div className="flex justify-between"><span className="text-fg-muted">Cases assigned to you</span><span className="font-medium tabular-nums">{s.assignedToMe}</span></div>}
        <div className="mt-2 flex gap-2">
          <Link href="/helpdesk" className={buttonClass('secondary', 'sm')}>Ask a question</Link>
          {s.assignedToMe !== null && <Link href="/helpdesk/queue" className={buttonClass('secondary', 'sm')}>Open queue</Link>}
        </div>
      </CardBody>
    </Card>
  );
}

function SetupWidget({ steps }: { steps: { done: boolean; label: string; href: string }[] }) {
  const doneCount = steps.filter((s) => s.done).length;
  return (
    <Card className="h-full">
      <CardHeader title="Set up your workspace" description={`${doneCount} of ${steps.length} done`} action={<div className="h-2 w-28 overflow-hidden rounded-full bg-bg-subtle"><div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} /></div>} />
      <CardBody>
        <ul className="flex flex-col divide-y divide-border">
          {steps.map((s) => (
            <li key={s.label} className="flex items-center gap-3 py-2.5">
              {s.done ? <CheckCircle2 className="size-5 text-success" aria-label="Done" /> : <Circle className="size-5 text-fg-subtle" aria-label="To do" />}
              <span className={s.done ? 'flex-1 text-fg-muted line-through decoration-fg-subtle/50' : 'flex-1'}>{s.label}</span>
              {!s.done && <Link href={s.href} className={buttonClass('secondary', 'sm')}>Start</Link>}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function AccessWidget({ roles, access, plan }: { roles: { key: string; name: string }[]; access: { key: string; description: string; scope: string }[]; plan: { name: string | null; status: string | null; included: number; total: number; maxEmployees: number; canView: boolean } }) {
  const [all, setAll] = useState(false);
  return (
    <Card className="h-full">
      <CardHeader title="Your access" description="What your roles let you do in this workspace, and for whom." action={<ShieldCheck className="size-5 text-accent" />} />
      <CardBody>
        <div className="mb-4 flex flex-wrap gap-1.5">{roles.map((r) => <Badge key={r.key} tone="accent">{r.name}</Badge>)}</div>
        {access.length ? (
          <ul className="grid gap-2">
            {(all ? access : access.slice(0, 6)).map((a) => (
              <li key={a.key} className="flex items-start justify-between gap-3 rounded-md bg-bg-subtle/70 px-3 py-2">
                <span className="text-[0.8125rem]">{a.description}</span>
                <span className="shrink-0 text-[0.6875rem] font-medium text-fg-subtle">{a.scope}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-[0.8125rem] text-fg-muted">Your self-service features appear here once your administrator gives you access.</p>}
        {access.length > 6 && <button type="button" className="mt-3 text-[0.8125rem] font-medium text-accent hover:underline" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${access.length}`}</button>}
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3 text-[0.8125rem]">
          <span className="text-fg-muted"><span className="font-medium capitalize text-fg">{plan.name ?? 'No'} plan</span>{plan.status === 'trialing' ? ' (trial)' : ''}: {plan.included} of {plan.total} capabilities{plan.maxEmployees > 0 ? `, up to ${plan.maxEmployees.toLocaleString()} people` : ''}</span>
          {plan.canView && <Link href="/settings/billing" className="shrink-0 text-accent hover:underline">View plan</Link>}
        </div>
      </CardBody>
    </Card>
  );
}
