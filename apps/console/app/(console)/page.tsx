import { Badge, Card, CardBody, CardHeader, PageHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Building2, Coins, Sparkles, Users } from 'lucide-react';
import Link from 'next/link';
import { Tile, TileRow } from '@/components/neon';
import { load } from '@/lib/api';

interface Metrics {
  tenants: { total: number; active: number; suspended: number; demo: number; newLast30Days: number };
  subscriptions: { plan: string; status: string; tenants: number; seats: number }[];
  mrrByCurrency: { currency: string; mrr: string }[];
  trialsEnding: { id: string; name: string; slug: string; trialEndsOn: string }[];
  members: { total: number; active: number };
  signups: { day: string; count: number }[];
  note: string;
}

const money = (v: string, c: string) => new Intl.NumberFormat('en', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(Number(v));

export default async function Overview() {
  const m = await load<Metrics>('/platform/metrics');
  const max = Math.max(1, ...m.signups.map((s) => s.count));
  return (
    <>
      <PageHeader title="Overview" description="CREW across all customers. Demo workspaces are counted separately and excluded from revenue." />
      <TileRow>
        <Tile tone="violet" icon={<Building2 className="size-5" />} label="Workspaces" value={m.tenants.total} href="/tenants" hint={`${m.tenants.active} active · ${m.tenants.suspended} suspended · ${m.tenants.demo} demo`} />
        <Tile tone="teal" icon={<Sparkles className="size-5" />} label="New in 30 days" value={m.tenants.newLast30Days} hint="Workspaces created" />
        <Tile tone="orange" icon={<Users className="size-5" />} label="Active members" value={m.members.active.toLocaleString()} hint={`${m.members.total.toLocaleString()} memberships in total`} />
        <Tile tone="blue" icon={<Coins className="size-5" />} label="MRR (list price)" value={m.mrrByCurrency.length ? m.mrrByCurrency.map((x) => money(x.mrr, x.currency)).join(' + ') : '—'} hint={m.note} />
      </TileRow>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader title="New workspaces, last 30 days" />
          <CardBody>
            <div className="flex h-32 items-end gap-1" role="img" aria-label={`Sign-ups per day; peak ${max}`}>
              {m.signups.map((s) => (
                <div key={s.day} title={`${s.day}: ${s.count}`} className="flex-1 rounded-t bg-gradient-to-t from-accent to-ember/80" style={{ height: `${Math.max(2, (s.count / max) * 100)}%`, opacity: s.count ? 1 : 0.25 }} />
              ))}
            </div>
            <div className="mt-2 flex justify-between text-[11px] text-fg-subtle"><span>{m.signups[0]?.day}</span><span>{m.signups.at(-1)?.day}</span></div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Trials ending within 7 days" />
          {m.trialsEnding.length === 0 ? <CardBody className="text-sm text-fg-muted">None.</CardBody> : (
            <ul className="divide-y divide-border border-t border-border">
              {m.trialsEnding.map((t) => (
                <li key={t.id} className="flex items-center justify-between px-5 py-2.5 text-[13px]">
                  <Link href={`/tenants/${t.id}`} className="font-medium hover:underline">{t.name}</Link>
                  <span className="text-fg-subtle tabular">{t.trialEndsOn}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="Subscriptions by plan" description="Excludes demo workspaces." />
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
    </>
  );
}
