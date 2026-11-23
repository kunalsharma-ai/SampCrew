import { COMMAND_RANGE_LABEL, COMMAND_RANGES, type CommandCenter, type ConsoleNotificationSummary } from '@crew/contracts';
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, cn, type Tone } from '@crew/ui';
import { Activity, AlertOctagon, AlertTriangle, ArrowRight, Briefcase, Building2, CheckCircle2, CreditCard, Info, Inbox, Network, Plus, Repeat, Sparkles, TrendingUp, Users, Wallet } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { BarChart, Donut, TrendChart } from '@/components/charts';
import { NotificationsPanel } from '@/components/notifications-panel';
import { LocalTime } from '@/components/local-time';
import { Tile, TileRow } from '@/components/neon';
import { api, load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import type { Admin } from '@/lib/types';
import { CustomRange } from './command-center-range';

export const metadata: Metadata = { title: 'Command center' };

const fmtMoney = (v: string | number, c: string) => {
  try { return new Intl.NumberFormat('en', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(Number(v)); } catch { return `${c} ${v}`; }
};
const compactMoney = (c: string) => (n: number) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: c, notation: 'compact', maximumFractionDigits: 1 }).format(n); } catch { return String(n); } };
const LEVEL: Record<string, { icon: typeof Info; tone: Tone; label: string }> = {
  critical: { icon: AlertOctagon, tone: 'danger', label: 'Critical' }, warning: { icon: AlertTriangle, tone: 'warning', label: 'Warning' }, info: { icon: Info, tone: 'info', label: 'Info' },
};
const SYSTEM: Record<CommandCenter['system']['status'], { tone: Tone; label: string }> = { operational: { tone: 'success', label: 'Operational' }, warning: { tone: 'warning', label: 'Warning' }, critical: { tone: 'danger', label: 'Critical' } };
const ACT_TONE: Record<string, string> = { success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger', info: 'bg-info' };

/**
 * The Console command center: everything happening across SampCrew for the chosen range. Workspace counts at every
 * level, growth, revenue and subscriptions (with billing permission), what needs action, support, system status and
 * the activity feed. Counts and company names only: no employee records are shown here.
 */
export default async function CommandCenterPage({ searchParams }: { searchParams: Promise<{ range?: string; from?: string; to?: string; currency?: string }> }) {
  const sp = await searchParams;
  const range = (COMMAND_RANGES as readonly string[]).includes(sp.range ?? '') ? sp.range! : '30d';
  const qs = new URLSearchParams({ range, ...(range === 'custom' && sp.from && sp.to ? { from: sp.from, to: sp.to } : {}), ...(sp.currency ? { currency: sp.currency } : {}) });
  if (range === 'custom' && !(sp.from && sp.to)) qs.set('range', '30d');
  const [me, cc, summary] = await Promise.all([
    load<Admin>('/platform/auth/me'),
    load<CommandCenter>(`/platform/command-center?${qs}`),
    api<ConsoleNotificationSummary>('/platform/notifications/summary').catch(() => null),
  ]);
  const money = hasCap(me, 'billing:read');
  const w = cc.workspaces;
  const r = cc.revenue;
  const cur = cc.currency;
  const link = (extra: Record<string, string>) => `/?${new URLSearchParams({ range, ...(sp.from ? { from: sp.from } : {}), ...(sp.to ? { to: sp.to } : {}), ...(sp.currency ? { currency: sp.currency } : {}), ...extra })}`;
  const monthChange = Number(r.previousMonth) ? Math.round(((Number(r.thisMonth) - Number(r.previousMonth)) / Number(r.previousMonth)) * 1000) / 10 : null;

  return (
    <>
      <PageHeader
        title="Command center"
        description="Everything happening across SampCrew: companies, workspaces, revenue, subscriptions, support and system health."
        actions={hasCap(me, 'tenants:manage') ? <Link href="/clients/new" className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-3.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"><Plus className="size-4" aria-hidden />New company</Link> : undefined}
      />

      <div className="mb-5 flex flex-wrap items-center gap-2" data-testid="range-picker">
        <div role="group" aria-label="Range" className="flex flex-wrap gap-1 rounded-xl border border-border bg-surface p-1">
          {COMMAND_RANGES.filter((k) => k !== 'custom').map((k) => (
            <Link key={k} href={link({ range: k, from: '', to: '' }).replace(/&?(from|to)=(&|$)/g, '$2')} aria-current={range === k ? 'true' : undefined}
              className={cn('rounded-lg px-2.5 py-1 text-[12.5px]', range === k ? 'crew-tab-active bg-accent font-medium text-accent-fg' : 'text-fg-muted hover:bg-bg-subtle hover:text-fg')}>{COMMAND_RANGE_LABEL[k]}</Link>
          ))}
        </div>
        <CustomRange active={range === 'custom'} from={sp.from} to={sp.to} />
        {money && cc.currencies.length > 1 && (
          <div role="group" aria-label="Currency" className="flex gap-1 rounded-xl border border-border bg-surface p-1">
            {cc.currencies.map((c) => <Link key={c} href={link({ currency: c })} aria-current={cur === c ? 'true' : undefined} className={cn('rounded-lg px-2 py-1 text-[12px]', cur === c ? 'bg-bg-subtle font-semibold' : 'text-fg-muted')}>{c}</Link>)}
          </div>
        )}
        <span className="ml-auto inline-flex items-center gap-2 text-[12px] text-fg-subtle">
          System <Link href="/health"><Badge tone={SYSTEM[cc.system.status].tone} dot>{SYSTEM[cc.system.status].label}</Badge></Link>
        </span>
      </div>

      <TileRow>
        <Tile tone="violet" icon={<Briefcase className="size-5" />} label="Companies" value={w.companies} href="/clients" hint={`${w.active} active · ${w.inactive} inactive · ${w.suspended} suspended`} testId="home-customers" />
        <Tile tone="teal" icon={<Network className="size-5" />} label="HR Workspaces" value={w.hrWorkspaces} href="/tenants" hint={`${w.superWorkspaces} Super Workspaces · ${w.employeeWorkspaces.toLocaleString()} Employee Workspaces`} testId="home-hr-workspaces" />
        <Tile tone="orange" icon={<Users className="size-5" />} label="Active users" value={w.activeUsers.toLocaleString()} href="/users" hint={`${w.employees.toLocaleString()} employees · ${w.hrAdminUsers} HR admins`} testId="home-users" />
        <Tile tone="blue" icon={<Sparkles className="size-5" />} label={`New in ${COMMAND_RANGE_LABEL[cc.range.key].toLowerCase()}`} value={w.newCompanies} hint={`${w.newWorkspaces} new workspaces · ${w.newCompaniesThisMonth} companies this month`} testId="home-new" />
      </TileRow>

      {money && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="revenue-kpis">
          <Kpi icon={<Wallet className="size-4" />} label="MRR" value={fmtMoney(r.mrr, cur)} hint={`ARR ${fmtMoney(r.arr, cur)} · ARPA ${fmtMoney(r.arpa, cur)}`} />
          <Kpi icon={<TrendingUp className="size-4" />} label="Revenue this month" value={fmtMoney(r.thisMonth, cur)} hint={monthChange === null ? `Last month ${fmtMoney(r.previousMonth, cur)}` : `${monthChange >= 0 ? '+' : ''}${monthChange}% on last month`} tone={monthChange !== null && monthChange < 0 ? 'danger' : 'success'} />
          <Kpi icon={<CreditCard className="size-4" />} label="Outstanding" value={fmtMoney(r.outstanding, cur)} hint={`${fmtMoney(r.pending, cur)} pending checkout · ${r.failedPayments} failed`} tone={Number(r.outstanding) > 0 ? 'warning' : undefined} href="/billing?tab=invoices&status=open" />
          <Kpi icon={<Repeat className="size-4" />} label="Subscriptions" value={r.activeSubscriptions} hint={`${r.trials} trials · ${r.renewalsDue} renewals due · ${r.expiringSoon} ending soon`} href="/billing" />
        </div>
      )}

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Growth" description={`New companies, workspaces and users per ${cc.range.bucket}`} />
          <CardBody><TrendChart testId="chart-growth" points={cc.series.growth} keys={[{ key: 'companies', label: 'Companies' }, { key: 'superWorkspaces', label: 'Super Workspaces' }, { key: 'hrWorkspaces', label: 'HR Workspaces' }, { key: 'users', label: 'Users' }]} /></CardBody>
        </Card>
        <Card data-testid="console-alerts">
          <CardHeader title="Needs action" description={cc.attention.length ? `${cc.attention.length} item(s), most urgent first` : 'Nothing needs you right now.'} />
          {cc.attention.length === 0 ? <CardBody className="flex items-center gap-2 text-sm text-fg-muted"><CheckCircle2 className="size-4 text-success" aria-hidden />All clear.</CardBody> : (
            <ul className="divide-y divide-border border-t border-border">
              {cc.attention.slice(0, 9).map((a) => {
                const L = LEVEL[a.level]!;
                return (
                  <li key={a.key}>
                    <Link href={a.href} className="group flex items-center gap-3 px-5 py-2.5 hover:bg-bg-subtle">
                      <L.icon className={cn('size-4 shrink-0', a.level === 'critical' ? 'text-danger' : a.level === 'warning' ? 'text-warning' : 'text-info')} aria-hidden />
                      <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{a.title}</span>{a.detail && <span className="block truncate text-[11px] text-fg-subtle">{a.detail}</span>}</span>
                      <Badge tone={L.tone}>{L.label}</Badge>
                      <ArrowRight className="size-3.5 text-fg-subtle group-hover:text-accent" aria-hidden />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {money && (
        <div className="mt-6 grid gap-6 xl:grid-cols-2">
          <Card>
            <CardHeader title="Revenue" description={`Collected and refunded per ${cc.range.bucket}, ${cur}. ${fmtMoney(r.inRange, cur)} in this range, ${fmtMoney(r.thisYear, cur)} this year.`} />
            <CardBody><BarChart testId="chart-revenue" points={cc.series.revenue} keys={[{ key: 'revenue', label: 'Collected' }, { key: 'refunds', label: 'Refunded' }]} format={compactMoney(cur)} /></CardBody>
          </Card>
          <Card>
            <CardHeader title="Subscriptions" description={`New, upgraded, downgraded and cancelled. Trial conversion ${r.conversionRate ?? '–'}%, churn ${r.churnRate ?? '–'}%.`} />
            <CardBody><TrendChart testId="chart-subscriptions" area={false} points={cc.series.subscriptions} keys={[{ key: 'new', label: 'New' }, { key: 'upgraded', label: 'Upgraded' }, { key: 'downgraded', label: 'Downgraded' }, { key: 'cancelled', label: 'Cancelled' }]} /></CardBody>
          </Card>
          <Card>
            <CardHeader title="Payments" description="Successful and failed payments" />
            <CardBody><BarChart points={cc.series.payments} keys={[{ key: 'succeeded', label: 'Succeeded' }, { key: 'failed', label: 'Failed' }]} /></CardBody>
          </Card>
          <Card>
            <CardHeader title="Outstanding" description={`Unpaid invoice total at the end of each ${cc.range.bucket}`} />
            <CardBody><TrendChart points={cc.series.outstanding} keys={[{ key: 'outstanding', label: 'Outstanding' }]} format={compactMoney(cur)} /></CardBody>
          </Card>
        </div>
      )}

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card data-testid="subscription-overview">
          <CardHeader title="Subscription overview" description={cc.subscriptions.mostPopular ? `Most popular: ${cc.subscriptions.mostPopular}` : 'No subscriptions yet'} />
          <CardBody>
            <Donut testId="chart-plans" items={cc.plans.map((p) => ({ label: p.name, value: p.companies, href: `/clients?plan=${p.key}` }))} centre={{ value: String(cc.plans.reduce((a, p) => a + p.companies, 0)), label: 'companies' }} />
            <dl className="mt-4 grid grid-cols-4 gap-2 border-t border-border pt-3 text-center text-[12px]">
              {[['Paid', cc.subscriptions.paid, '/clients?paid=paid'], ['Free', cc.subscriptions.free, '/clients?paid=free'], ['Trial', cc.subscriptions.trial, '/clients?status=trial'], ['Enterprise', cc.subscriptions.enterprise, '/clients?paid=enterprise']].map(([l, v, h]) => (
                <Link key={l as string} href={h as string} className="rounded-lg py-1 hover:bg-bg-subtle"><dd className="text-lg font-semibold tabular">{v}</dd><dt className="text-fg-subtle">{l}</dt></Link>
              ))}
            </dl>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Renewals and endings" description="Next renewals, trials ending and cancellations" />
          <ul className="divide-y divide-border border-t border-border text-[13px]">
            {cc.subscriptions.upcomingRenewals.map((x) => <ListRow key={`r${x.tenantId}`} name={x.name} href={x.clientId ? `/clients/${x.clientId}?tab=billing` : `/tenants/${x.tenantId}`} meta={`${x.plan ?? ''} · renews ${x.on}`} right={money ? x.amount : undefined} />)}
            {cc.subscriptions.expiring.map((x) => <ListRow key={`e${x.tenantId}`} name={x.name} href={x.clientId ? `/clients/${x.clientId}?tab=billing` : `/tenants/${x.tenantId}`} meta={`${x.plan ?? ''} · ${x.reason === 'trial' ? 'trial ends' : 'ends'} ${x.on}`} badge={<Badge tone="warning">{x.reason === 'trial' ? 'Trial' : 'Cancelling'}</Badge>} />)}
            {cc.subscriptions.downgraded.slice(0, 3).map((x) => <ListRow key={`d${x.tenantId}${x.at}`} name={x.name} href={x.clientId ? `/clients/${x.clientId}` : `/tenants/${x.tenantId}`} meta={`${x.from ?? '?'} → ${x.to ?? '?'}`} badge={<Badge tone="danger">Downgraded</Badge>} />)}
            {cc.subscriptions.upgraded.slice(0, 3).map((x) => <ListRow key={`u${x.tenantId}${x.at}`} name={x.name} href={x.clientId ? `/clients/${x.clientId}` : `/tenants/${x.tenantId}`} meta={`${x.from ?? '?'} → ${x.to ?? '?'}`} badge={<Badge tone="success">Upgraded</Badge>} />)}
            {!cc.subscriptions.upcomingRenewals.length && !cc.subscriptions.expiring.length && !cc.subscriptions.upgraded.length && !cc.subscriptions.downgraded.length && <li className="px-5 py-6 text-center text-fg-subtle">Nothing coming up.</li>}
          </ul>
        </Card>
        <Card>
          <CardHeader title="Fastest growing" description="Most new users in this range" />
          {!cc.growing.length ? <CardBody className="text-[13px] text-fg-subtle">No new users in this range.</CardBody> : (
            <ul className="divide-y divide-border border-t border-border text-[13px]">
              {cc.growing.map((g) => <ListRow key={g.tenantId} name={g.name} href={g.clientId ? `/clients/${g.clientId}?tab=users` : `/tenants/${g.tenantId}`} meta={`${g.total} users in total`} right={`+${g.added}`} />)}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card data-testid="console-activity">
          <CardHeader title="Activity" description="New companies, workspaces, users, payments, plan changes, support and security" action={<Link href="/notifications" className="text-[12.5px] font-medium text-accent hover:underline">History</Link>} />
          {!cc.activity.length ? <EmptyState icon={<Activity />} title="Nothing yet" description="Events appear here as they happen." /> : (
            <ol className="divide-y divide-border border-t border-border">
              {cc.activity.map((a) => (
                <li key={a.id} className="flex items-start gap-3 px-5 py-2.5 text-[13px]">
                  <span aria-hidden className={cn('mt-1.5 size-2 shrink-0 rounded-full', ACT_TONE[a.status])} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{a.title}</span>
                    <span className="block truncate text-[11.5px] text-fg-muted">{[a.company, a.user].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="shrink-0 text-right text-[11px] text-fg-subtle">
                    <LocalTime value={a.at} relative />
                    {a.href && <Link href={a.href} className="block font-medium text-accent hover:underline">{a.action ?? 'Open'}</Link>}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>
        <div className="grid content-start gap-6">
          <NotificationsPanel initial={summary} />
          {(hasCap(me, 'support:chat') || hasCap(me, 'help:answer')) && (
            <Card>
              <CardHeader title="Support" description="Conversations with Super Workspaces and tickets" />
              <CardBody className="grid grid-cols-2 gap-3 text-center">
                <Link href="/support" className="rounded-xl border border-border p-3 hover:bg-bg-subtle"><Inbox className="mx-auto mb-1 size-4 text-accent" aria-hidden /><div className="text-xl font-semibold tabular">{cc.support.unread}</div><div className="text-[11.5px] text-fg-subtle">unread of {cc.support.openConversations} open</div></Link>
                <Link href="/help-queries" className="rounded-xl border border-border p-3 hover:bg-bg-subtle"><Building2 className="mx-auto mb-1 size-4 text-accent" aria-hidden /><div className="text-xl font-semibold tabular">{cc.support.waitingTickets}</div><div className="text-[11.5px] text-fg-subtle">waiting of {cc.support.openTickets} open tickets</div></Link>
              </CardBody>
            </Card>
          )}
        </div>
      </div>
      {w.demo > 0 && <p className="mt-6 text-[12px] text-fg-subtle">{w.demo} demo {w.demo === 1 ? 'company is' : 'companies are'} left out of every figure.</p>}
    </>
  );
}

function Kpi({ icon, label, value, hint, tone, href }: { icon: React.ReactNode; label: string; value: React.ReactNode; hint?: string; tone?: 'success' | 'danger' | 'warning'; href?: string }) {
  const body = (
    <>
      <div className="flex items-center gap-2 text-[12.5px] text-fg-muted"><span className="flex size-7 items-center justify-center rounded-lg bg-accent-subtle text-accent" aria-hidden>{icon}</span>{label}</div>
      <div className="mt-2 text-[1.5rem] font-semibold tracking-tight tabular">{value}</div>
      {hint && <div className={cn('mt-0.5 truncate text-[11.5px]', tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : tone === 'success' ? 'text-success' : 'text-fg-subtle')}>{hint}</div>}
    </>
  );
  return href ? <Link href={href} className="crew-card block rounded-xl border border-border bg-surface p-4 shadow-card hover:border-border-strong">{body}</Link> : <div className="crew-card rounded-xl border border-border bg-surface p-4 shadow-card">{body}</div>;
}

function ListRow({ name, href, meta, right, badge }: { name: string; href: string; meta: string; right?: string; badge?: React.ReactNode }) {
  return (
    <li>
      <Link href={href} className="flex items-center gap-3 px-5 py-2 hover:bg-bg-subtle">
        <span className="min-w-0 flex-1"><span className="block truncate font-medium">{name}</span><span className="block truncate text-[11.5px] text-fg-subtle">{meta}</span></span>
        {badge}
        {right && <span className="shrink-0 tabular text-[12.5px] font-medium">{right}</span>}
      </Link>
    </li>
  );
}
