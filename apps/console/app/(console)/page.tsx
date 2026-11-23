import { ATTENTION_LABEL, type AttentionLevel, type PlatformHome } from '@crew/contracts';
import { Badge, Card, CardBody, CardHeader, PageHeader, Table, TBody, TD, TH, THead, TR, type Tone } from '@crew/ui';
import { AlertOctagon, AlertTriangle, ArrowRight, BellRing, Building2, CheckCircle2, Coins, Info, Network, ShieldAlert, Sparkles, UserCheck, Users } from 'lucide-react';
import Link from 'next/link';
import { LocalTime } from '@/components/local-time';
import { Tile, TileRow } from '@/components/neon';
import { api, load } from '@/lib/api';

interface Metrics {
  subscriptions: { plan: string; status: string; tenants: number; seats: number }[];
  mrrByCurrency: { currency: string; mrr: string }[];
  note: string;
  trialsEnding: { id: string; name: string; trialEndsOn: string }[];
}

const money = (v: string, c: string) => new Intl.NumberFormat('en', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(Number(v));
const LEVEL: Record<AttentionLevel, { icon: typeof Info; tone: Tone }> = {
  normal: { icon: CheckCircle2, tone: 'neutral' }, info: { icon: Info, tone: 'info' }, attention: { icon: BellRing, tone: 'accent' },
  warning: { icon: AlertTriangle, tone: 'warning' }, critical: { icon: AlertOctagon, tone: 'danger' },
};

function LevelTag({ level }: { level: AttentionLevel }) {
  const l = LEVEL[level];
  return <Badge tone={l.tone}><l.icon className="mr-1 inline size-3" aria-hidden />{ATTENTION_LABEL[level]}</Badge>;
}

/**
 * The Console's Home: is SampCrew and its customers' workspaces running correctly? Platform figures, workspaces that
 * need a look, alerts worked out from system health and pending requests, and recent administrative events. Counts
 * only: no employee records are shown here.
 */
export default async function Overview() {
  const [h, m] = await Promise.all([load<PlatformHome>('/platform/home'), api<Metrics>('/platform/metrics').catch(() => null)]);
  const o = h.overview;
  const max = Math.max(1, ...h.signups.map((s) => s.count));
  return (
    <>
      <PageHeader title="Platform overview" description="SampCrew across all customers: workspaces at every level, users, system health and what needs a Console Admin." />
      <TileRow>
        <Tile tone="violet" icon={<Building2 className="size-5" />} label="Customers" value={o.customers} href="/tenants" hint={`${o.superWorkspaces} Super Workspaces · ${o.demo} demo`} testId="home-customers" />
        <Tile tone="teal" icon={<Network className="size-5" />} label="HR Workspaces" value={o.hrWorkspaces} hint={`${o.employeeWorkspaces.toLocaleString()} Employee Workspaces`} testId="home-hr-workspaces" />
        <Tile tone="orange" icon={<Users className="size-5" />} label="Active users" value={o.activeUsers.toLocaleString()} href="/users" hint={`${o.activeToday.toLocaleString()} signed in today`} testId="home-users" />
        <Tile tone="blue" icon={<Sparkles className="size-5" />} label="New in 30 days" value={o.newWorkspaces} hint={`${o.suspended} suspended · ${o.pendingActions} pending actions`} testId="home-new" />
      </TileRow>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <Card data-testid="console-alerts">
          <CardHeader title="System alerts" description={h.alerts.length ? `${h.alerts.length} item(s), most urgent first` : 'Nothing needs you right now.'} />
          {h.alerts.length === 0 ? <CardBody className="flex items-center gap-2 text-sm text-fg-muted"><CheckCircle2 className="size-4 text-success" aria-hidden />All systems normal.</CardBody> : (
            <ul className="divide-y divide-border border-t border-border">
              {h.alerts.map((a) => {
                const L = LEVEL[a.level];
                return (
                  <li key={a.key}>
                    <Link href={a.href} className="group flex items-center gap-3 px-5 py-2.5 hover:bg-bg-subtle">
                      <L.icon className="size-4 shrink-0" aria-hidden />
                      <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{a.title}</span>{a.detail && <span className="block truncate text-[11px] text-fg-subtle">{a.detail}</span>}</span>
                      <LevelTag level={a.level} />
                      <span className="hidden items-center gap-1 text-xs font-medium text-accent sm:inline-flex">{a.cta}<ArrowRight className="size-3" aria-hidden /></span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card data-testid="workspace-health">
          <CardHeader title="Workspace health" description={`${h.health.active} active, ${h.health.inactive} with no sign-in for 30 days, ${h.health.trialing} on trial, ${h.health.pastDue} overdue.`} />
          {h.health.attention.length === 0 ? <CardBody className="text-sm text-fg-muted">Every workspace looks fine.</CardBody> : (
            <ul className="divide-y divide-border border-t border-border">
              {h.health.attention.map((w, i) => (
                <li key={`${w.id}${i}`} className="flex items-center justify-between gap-3 px-5 py-2.5 text-[13px]">
                  <Link href={`/tenants/${w.id}`} className="font-medium hover:underline">{w.name}</Link>
                  <span className="flex items-center gap-2 text-fg-muted">{w.reason}<LevelTag level={w.level} /></span>
                </li>
              ))}
            </ul>
          )}
          <CardBody className="flex flex-wrap gap-2 border-t border-border">
            {h.health.integrations.map((x) => <Badge key={x.key} tone={x.on ? 'success' : 'neutral'}>{x.name}: {x.on ? 'on' : 'off'}</Badge>)}
          </CardBody>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Card data-testid="console-activity">
          <CardHeader title="Administrative activity" description="Workspace creation, access and permission changes, imports and security events in the last 14 days." action={<Link href="/audit" className="text-xs font-medium text-accent hover:underline">Audit trail</Link>} />
          {h.activity.length === 0 ? <CardBody className="text-sm text-fg-muted">Nothing recent.</CardBody> : (
            <ul className="divide-y divide-border border-t border-border">
              {h.activity.map((e, i) => (
                <li key={i} className="flex items-center gap-3 px-5 py-2 text-[13px]">
                  {e.level === 'warning' ? <ShieldAlert className="size-4 shrink-0 text-warning" aria-label="Warning" /> : <UserCheck className="size-4 shrink-0 text-fg-subtle" aria-hidden />}
                  <span className="min-w-0 flex-1 truncate">{e.title}{e.workspace && <span className="text-fg-subtle"> · {e.workspace}</span>}{e.actor && <span className="text-fg-subtle"> · {e.actor}</span>}</span>
                  <span className="shrink-0 text-[11px] text-fg-subtle"><LocalTime value={e.at} /></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="grid content-start gap-6">
          <Card>
            <CardHeader title="New workspaces, last 30 days" />
            <CardBody>
              <div className="flex h-28 items-end gap-1" role="img" aria-label={`Sign-ups per day; peak ${max}`}>
                {h.signups.map((s) => (
                  <div key={s.day} title={`${s.day}: ${s.count}`} className="flex-1 rounded-t bg-gradient-to-t from-accent to-ember/80" style={{ height: `${Math.max(2, (s.count / max) * 100)}%`, opacity: s.count ? 1 : 0.25 }} />
                ))}
              </div>
              <div className="mt-2 flex justify-between text-[11px] text-fg-subtle"><span>{h.signups[0]?.day}</span><span>{h.signups.at(-1)?.day}</span></div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Recently created" />
            <ul className="divide-y divide-border border-t border-border">
              {h.health.recent.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-2 px-5 py-2 text-[13px]">
                  <Link href={`/tenants/${t.id}`} className="truncate font-medium hover:underline">{t.name}</Link>
                  <span className="shrink-0 text-[11px] text-fg-subtle"><LocalTime value={t.createdAt} dateOnly /></span>
                </li>
              ))}
            </ul>
          </Card>
          {m && (
            <Card>
              <CardHeader title="Trials ending within 7 days" />
              {m.trialsEnding.length === 0 ? <CardBody className="text-sm text-fg-muted">None.</CardBody> : (
                <ul className="divide-y divide-border border-t border-border" data-testid="console-trials">
                  {m.trialsEnding.map((t) => (
                    <li key={t.id} className="flex items-center justify-between px-5 py-2 text-[13px]">
                      <Link href={`/tenants/${t.id}`} className="font-medium hover:underline">{t.name}</Link>
                      <span className="text-fg-subtle tabular">{t.trialEndsOn}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>
      </div>

      {m && (
        <Card className="mt-6">
          <CardHeader title="Subscriptions by plan" description={`Excludes demo workspaces. MRR: ${m.mrrByCurrency.length ? m.mrrByCurrency.map((x) => money(x.mrr, x.currency)).join(' + ') : '—'}.`} action={<Coins className="size-4 text-fg-subtle" aria-hidden />} />
          <Table>
            <THead><TR><TH>Plan</TH><TH>Status</TH><TH className="text-right">Workspaces</TH><TH className="text-right">Seats</TH></TR></THead>
            <TBody>
              {m.subscriptions.length === 0 && <TR><TD colSpan={4} className="text-fg-muted">No customer subscriptions yet.</TD></TR>}
              {m.subscriptions.map((s) => (
                <TR key={`${s.plan}-${s.status}`}>
                  <TD className="capitalize">{s.plan}</TD>
                  <TD><Badge tone={s.status === 'active' ? 'success' : s.status === 'trialing' ? 'accent' : 'warning'}>{s.status}</Badge></TD>
                  <TD className="text-right tabular">{s.tenants}</TD>
                  <TD className="text-right tabular">{s.seats.toLocaleString()}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </>
  );
}
