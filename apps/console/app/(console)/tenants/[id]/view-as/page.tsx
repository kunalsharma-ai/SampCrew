import type { ViewAsSession, WorkspaceUserRow } from '@crew/contracts';
import { Alert, Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR, cn } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { LocalTime } from '@/components/local-time';
import { ApiError, api, load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import type { Admin } from '@/lib/types';
import { ViewAsBanner } from './view-as-banner';

export const metadata: Metadata = { title: 'View as' };

const LABEL: Record<ViewAsSession['sections'][number], string> = { overview: 'Overview', structure: 'Structure', users: 'Users', modules: 'Modules', activity: 'Activity', billing: 'Subscription' };

type Overview = { overview: { legalEntities: number; locations: number; departments: number; activeMembers: number }; roles: { name: string; members: number }[]; config: { name: string; status: string; timezone: string; region: string; locale: string; country: string | null; setupDone: boolean; requireMfa: boolean } | null };
type Structure = { hrWorkspaces: { id: string; name: string; kind: string; status: string; maxEmployees: number }[]; legalEntities: string[]; locations: string[]; departments: string[] };
type Modules = { plan: string | null; status: string | null; modules: { key: string; label: string }[]; limits: { key: string; label: string; value: number }[] };
type Activity = { items: { action: string; actorLabel: string | null; createdAt: string }[] };
type Users = { total: number; items: WorkspaceUserRow[] };
type Billing = { subscription: { status: string; seats: number; currency: string; cycle: string; periodEnd: string; trialEndsOn: string | null } | null };

/**
 * "View as": the read-only support view of a client's Super Workspace while the client's approval lasts. A banner shows
 * the time left and Exit; every section opened is logged in both audit trails; nothing goes past the admin's own role.
 */
export default async function ViewAsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ section?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const me = await load<Admin>('/platform/auth/me');
  if (!hasCap(me, 'support:request')) return <><PageHeader title="View as" /><Alert tone="warning">Your role cannot use support access.</Alert></>;
  const { session } = await load<{ session: ViewAsSession | null }>(`/platform/tenants/${id}/view-as`);
  if (!session) {
    return (
      <>
        <PageHeader title="View as" description="A read-only look at a client's workspace, only while the client has approved your support access request." />
        <Card><EmptyState title="No approved support access" description="Request access on the workspace page. The client's Super Workspace Admin approves it in SampCrew, for a limited time." action={<Link href={`/tenants/${id}`} className="text-[13px] text-accent hover:underline">Go to the workspace to request access</Link>} /></Card>
      </>
    );
  }
  const section = (session.sections as string[]).includes(sp.section ?? '') ? (sp.section as ViewAsSession['sections'][number]) : 'overview';
  const data = await api<Record<string, unknown>>(`/platform/tenants/${id}/view-as/${section}`).then((d) => ({ ok: true as const, d })).catch((e: ApiError | Error) => ({ ok: false as const, message: e.message }));
  return (
    <>
      <ViewAsBanner session={session} />
      <PageHeader title={`Viewing ${session.workspace}`} description={`Read only. Reason given: ${session.reason}${session.approvedBy ? ` · approved by ${session.approvedBy}` : ''}. Employee records, messages, documents, payroll and attendance are never shown here.`} />
      <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-border" aria-label="Sections" data-testid="view-as-tabs">
        {session.sections.map((s) => <Link key={s} href={`/tenants/${id}/view-as?section=${s}`} aria-current={s === section ? 'page' : undefined} className={cn('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px]', s === section ? 'border-accent font-medium text-accent' : 'border-transparent text-fg-muted hover:text-fg')}>{LABEL[s]}</Link>)}
      </nav>
      {!data.ok ? <Alert tone="danger">{data.message}</Alert> : <Section section={section} d={data.d} />}
    </>
  );
}

function Section({ section, d }: { section: string; d: Record<string, unknown> }) {
  if (section === 'overview') {
    const o = d as unknown as Overview;
    return (
      <div className="grid gap-5 lg:grid-cols-2" data-testid="view-as-overview">
        <Card><CardHeader title="Workspace" /><CardBody className="grid grid-cols-2 gap-3 text-[13px]">
          {o.config && <>
            <KV k="Status" v={o.config.status} /><KV k="Setup" v={o.config.setupDone ? 'Done' : 'Not finished'} />
            <KV k="Country" v={o.config.country ?? '—'} /><KV k="Time zone" v={o.config.timezone} />
            <KV k="Region" v={o.config.region.toUpperCase()} /><KV k="Two-step for admins" v={o.config.requireMfa ? 'Required' : 'Optional'} />
          </>}
          <KV k="Legal entities" v={o.overview.legalEntities} /><KV k="Locations" v={o.overview.locations} />
          <KV k="Departments" v={o.overview.departments} /><KV k="Active members" v={o.overview.activeMembers} />
        </CardBody></Card>
        <Card><CardHeader title="Levels" description="How many people hold each level." /><CardBody className="grid gap-1.5 text-[13px]">{o.roles.map((r) => <div key={r.name} className="flex justify-between"><span>{r.name}</span><span className="tabular">{r.members}</span></div>)}</CardBody></Card>
      </div>
    );
  }
  if (section === 'structure') {
    const s = d as unknown as Structure;
    return (
      <div className="grid gap-5 lg:grid-cols-2">
        <Card><CardHeader title="HR Workspaces" /><Table aria-label="HR Workspaces"><THead><TR><TH>Name</TH><TH>Status</TH></TR></THead><TBody>{s.hrWorkspaces.map((h) => <TR key={h.id}><TD>{h.name}</TD><TD><Badge>{h.status}</Badge></TD></TR>)}</TBody></Table>{!s.hrWorkspaces.length && <CardBody className="text-[13px] text-fg-muted">None yet.</CardBody>}</Card>
        <Card><CardHeader title="Organisation" /><CardBody className="grid gap-3 text-[13px]">
          <List k="Legal entities" v={s.legalEntities} /><List k="Locations" v={s.locations} /><List k="Departments" v={s.departments} />
        </CardBody></Card>
      </div>
    );
  }
  if (section === 'modules') {
    const m = d as unknown as Modules;
    return (
      <Card><CardHeader title={m.plan ? `Plan: ${m.plan}` : 'No plan'} description={m.status ? `Subscription ${m.status}` : undefined} /><CardBody className="grid gap-3">
        <div className="flex flex-wrap gap-1.5">{m.modules.map((x) => <Badge key={x.key} tone="accent">{x.label}</Badge>)}</div>
        <dl className="grid gap-1 text-[13px] sm:grid-cols-2">{m.limits.map((l) => <div key={l.key} className="flex justify-between gap-2"><dt className="text-fg-muted">{l.label}</dt><dd className="tabular">{l.value === -1 ? 'Unlimited' : l.value}</dd></div>)}</dl>
      </CardBody></Card>
    );
  }
  if (section === 'activity') {
    const a = d as unknown as Activity;
    return <Card><Table aria-label="Recent activity"><THead><TR><TH>When</TH><TH>Who</TH><TH>What</TH></TR></THead><TBody>{a.items.map((x, i) => <TR key={i}><TD className="whitespace-nowrap text-fg-muted"><LocalTime value={x.createdAt} /></TD><TD>{x.actorLabel ?? 'System'}</TD><TD className="font-mono text-[12px]">{x.action}</TD></TR>)}</TBody></Table></Card>;
  }
  if (section === 'users') {
    const u = d as unknown as Users;
    return <Card><CardHeader title={`${u.total} people`} description="Names, levels and status only. Emails are masked unless your role may see contact details." /><Table aria-label="Users"><THead><TR><TH>Person</TH><TH>Levels</TH><TH>Status</TH><TH>Last sign-in</TH></TR></THead><TBody>{u.items.map((x) => <TR key={x.membershipId}><TD>{x.fullName}<span className="block text-[11.5px] text-fg-subtle">{x.email}</span></TD><TD className="text-[12.5px]">{x.roles.join(', ')}</TD><TD><Badge>{x.status}</Badge></TD><TD className="whitespace-nowrap text-fg-muted">{x.lastLoginAt ? <LocalTime value={x.lastLoginAt} /> : 'Never'}</TD></TR>)}</TBody></Table></Card>;
  }
  if (section === 'billing') {
    const b = (d as unknown as Billing).subscription;
    return <Card><CardHeader title="Subscription" /><CardBody className="grid grid-cols-2 gap-3 text-[13px]">{b ? <><KV k="Status" v={b.status} /><KV k="Seats" v={b.seats} /><KV k="Cycle" v={b.cycle} /><KV k="Currency" v={b.currency} /><KV k="Period ends" v={b.periodEnd} /><KV k="Trial ends" v={b.trialEndsOn ?? '—'} /></> : <p className="text-fg-muted">No subscription.</p>}</CardBody></Card>;
  }
  return null;
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return <div><div className="text-[11.5px] text-fg-subtle">{k}</div><div className="mt-0.5">{v}</div></div>;
}
function List({ k, v }: { k: string; v: string[] }) {
  return <div><div className="text-[11.5px] text-fg-subtle">{k} ({v.length})</div><div className="mt-0.5">{v.length ? v.join(', ') : 'None'}</div></div>;
}
