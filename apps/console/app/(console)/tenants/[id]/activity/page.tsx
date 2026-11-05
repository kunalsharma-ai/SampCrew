import { PLATFORM_ROLE_CAPABILITIES, type ActivityRow } from '@crew/contracts';
import { Badge, buttonClass, Card, CardBody, CardHeader, EmptyState, Input, PageHeader, Select, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Activity, Globe, LogIn, Smartphone, Users } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Tile, TileRow, WorkspaceTabs } from '@/components/neon';
import { load } from '@/lib/api';
import type { Admin, TenantDetail } from '@/lib/types';

export const metadata: Metadata = { title: 'Workspace activity' };

interface ActivityPage {
  items: ActivityRow[]; nextBefore: number | null;
  summary: { events7d: number; webSignIns30d: number; mobileSignIns30d: number; activeUsers7d: number; activeUsers30d: number };
  areas: { area: string; n: number }[];
}

const ACTOR: Record<string, string> = { user: 'Person', platform_admin: 'SAMPLEDGE', system: 'System', ai_agent: 'AI', integration: 'Integration' };

export default async function ActivityPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ q?: string; area?: string; actor?: string; before?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const q = (sp.q ?? '').slice(0, 100);
  const area = /^[a-z_]{1,40}$/.test(sp.area ?? '') ? sp.area! : '';
  const actor = Object.keys(ACTOR).includes(sp.actor ?? '') ? sp.actor! : '';
  const before = /^\d+$/.test(sp.before ?? '') ? sp.before! : '';
  const qs = new URLSearchParams({ limit: '50', ...(q ? { q } : {}), ...(area ? { area } : {}), ...(actor ? { actorType: actor } : {}), ...(before ? { before } : {}) });
  const [me, t, data] = await Promise.all([
    load<Admin>('/platform/auth/me'),
    load<TenantDetail>(`/platform/tenants/${id}`),
    load<ActivityPage>(`/platform/tenants/${id}/activity?${qs}`),
  ]);
  const s = data.summary;
  const max = Math.max(1, ...data.areas.map((a) => a.n));
  const link = (extra: Record<string, string>) => {
    const p = new URLSearchParams(Object.entries({ q, area, actor, ...extra }).filter(([, v]) => v));
    return `/tenants/${id}/activity${p.size ? `?${p}` : ''}`;
  };
  return (
    <>
      <PageHeader
        eyebrow={<><Link href="/tenants" className="hover:underline">Workspaces</Link> / <Link href={`/tenants/${id}`} className="hover:underline">{t.name}</Link></>}
        title="Activity"
        description="What happened in this workspace, who did it, when and from which app. Open an event to see what changed (before and after values); each one you open is recorded in the customer's activity trail."
      />
      <WorkspaceTabs tenantId={id} current="activity" caps={[...(PLATFORM_ROLE_CAPABILITIES[me.role] ?? [])]} />
      <TileRow>
        <Tile tone="violet" icon={<Activity className="size-5" />} label="Events in 7 days" value={s.events7d.toLocaleString()} testId="tile-events" />
        <Tile tone="teal" icon={<Users className="size-5" />} label="Active people in 7 days" value={s.activeUsers7d} hint={`${s.activeUsers30d} in 30 days`} />
        <Tile tone="blue" icon={<Globe className="size-5" />} label="Web sign-ins, 30 days" value={s.webSignIns30d} />
        <Tile tone="pink" icon={<Smartphone className="size-5" />} label="Mobile sign-ins, 30 days" value={s.mobileSignIns30d} testId="tile-mobile-signins" />
      </TileRow>
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <Card>
          <CardHeader title="Events" />
          <CardBody className="pb-0">
            <form className="flex flex-wrap gap-2" action={`/tenants/${id}/activity`}>
              <Input name="q" defaultValue={q} placeholder="Action, person or record type" className="h-9 w-64" aria-label="Search activity" />
              <div className="w-44"><Select name="actor" defaultValue={actor} className="h-9 w-40" aria-label="Who">
                <option value="">Anyone</option>{Object.entries(ACTOR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select></div>
              {area && <input type="hidden" name="area" value={area} />}
              <button className={buttonClass('secondary')} type="submit">Filter</button>
              {(q || area || actor) && <Link className={buttonClass('ghost')} href={`/tenants/${id}/activity`}>Clear</Link>}
            </form>
          </CardBody>
          {data.items.length === 0 ? <EmptyState icon={<Activity className="size-6" />} title="No activity matches" /> : (
            <Table aria-label="Activity">
              <THead><TR><TH>When</TH><TH>What</TH><TH>Who</TH><TH>From</TH><TH><span className="sr-only">Contents</span></TH></TR></THead>
              <TBody>
                {data.items.map((a) => (
                  <TR key={a.id}>
                    <TD className="whitespace-nowrap text-fg-muted">{new Date(a.createdAt).toLocaleString()}</TD>
                    <TD><code className="text-xs">{a.action}</code><div className="text-[11px] text-fg-subtle">{a.resourceType}</div></TD>
                    <TD><div className="max-w-[16rem] truncate">{a.actorLabel ?? '—'}</div><div className="text-[11px] text-fg-subtle">{ACTOR[a.actorType] ?? a.actorType}</div></TD>
                    <TD className="whitespace-nowrap text-xs text-fg-muted">
                      {a.client === 'mobile' ? <Badge tone="accent"><Smartphone className="mr-1 inline size-3" aria-hidden />Mobile</Badge> : a.client === 'web' ? <Badge><Globe className="mr-1 inline size-3" aria-hidden />Web</Badge> : null}
                      {a.ip && <div className="mt-0.5 font-mono">{a.ip}</div>}
                    </TD>
                    <TD className="whitespace-nowrap text-right">
                      <Link className={buttonClass(a.hasChanges ? 'secondary' : 'ghost', 'sm')} href={`/tenants/${id}/activity/${a.id}`} aria-label={`${a.hasChanges ? 'View changes' : 'Details'}: ${a.action}, ${new Date(a.createdAt).toLocaleString()}`}>
                        {a.hasChanges ? 'View changes' : 'Details'}
                      </Link>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          {data.nextBefore && <CardBody><Link className={buttonClass('secondary', 'sm')} href={link({ before: String(data.nextBefore) })}>Older events</Link></CardBody>}
        </Card>
        <Card>
          <CardHeader title="Busiest areas, 30 days" />
          <CardBody>
            <ul className="grid gap-2" aria-label="Busiest areas">
              {data.areas.map((x) => (
                <li key={x.area}>
                  <Link href={link({ area: x.area, before: '' })} className="flex items-center justify-between text-[13px] hover:underline" aria-current={x.area === area ? 'true' : undefined}>
                    <span className="flex items-center gap-1.5">{x.area === 'auth' && <LogIn className="size-3.5" aria-hidden />}{x.area}</span><span className="tabular-nums text-fg-subtle">{x.n}</span>
                  </Link>
                  <div className="mt-1 h-1.5 rounded-full bg-bg-subtle"><div className="h-1.5 rounded-full bg-gradient-to-r from-accent to-ember" style={{ width: `${(x.n / max) * 100}%` }} /></div>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
