import { FEATURES, PERMISSIONS } from '@crew/contracts';
import { Badge, Card, CardBody, CardHeader, PageHeader, Stat, buttonClass } from '@crew/ui';
import { Building2, CheckCircle2, Circle, Globe2, LifeBuoy, MapPin, Network, ShieldCheck, Sparkles, Users } from 'lucide-react';
import Link from 'next/link';
import { load, loadOptional } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Me } from '@/lib/types';
import { dateTime } from './helpdesk/labels';
import type { Announcement, Summary } from './helpdesk/types';

interface Overview { legalEntities: number; businessUnits: number; locations: number; departments: number; activeMembers: number; pendingInvites: number; countries: number }

const SCOPE_LABEL: Record<string, string> = { own: 'Yourself', team: 'Your team', department: 'Your department', entity: 'Your legal entity', tenant: 'Whole organization' };

const ROADMAP = [
  { phase: 8, title: 'AI & automation', items: 'Copilots, workflow studio, predictive insights' },
];

export default async function HomePage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const { welcome } = await searchParams;
  const me = await load<Me>('/me');
  const overview = can(me, 'org:read') ? await loadOptional<Overview>('/org/overview') : null;
  const isAdmin = can(me, 'org:manage') || can(me, 'users:invite');
  const selfService = me.features.includes('self_service');
  const [news, helpdesk] = selfService
    ? await Promise.all([can(me, 'announcements:read') ? loadOptional<Announcement[]>('/announcements') : null, can(me, 'helpdesk:use') ? loadOptional<Summary>('/helpdesk/summary') : null])
    : [null, null];
  const unreadNews = (news ?? []).filter((a) => !a.readAt || (a.requiresAck && !a.acknowledgedAt));
  const firstName = me.user.fullName.split(' ')[0];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const steps = overview
    ? [
        { done: overview.legalEntities > 0, label: 'Add your legal entities', href: '/organization?tab=entities' },
        { done: overview.locations > 0, label: 'Add offices, plants or sites', href: '/organization?tab=locations' },
        { done: overview.departments > 0, label: 'Build your department structure', href: '/organization?tab=departments' },
        { done: overview.activeMembers + overview.pendingInvites > 1, label: 'Invite your HR team', href: '/people' },
        { done: me.user.mfaEnabled, label: 'Turn on two-step verification', href: '/settings/security' },
      ]
    : [];
  const doneCount = steps.filter((s) => s.done).length;

  const myAccess = Object.entries(me.permissions)
    .map(([key, scope]) => ({ def: PERMISSIONS.find((p) => p.key === key), scope }))
    .filter((x) => x.def && x.def.phase <= 7);

  return (
    <>
      <PageHeader
        eyebrow={me.tenant.name}
        title={welcome ? `Welcome to CREW, ${firstName}` : `${greeting}, ${firstName}`}
        description={welcome ? 'Your workspace is ready. Start by shaping your organization, then invite your team.' : 'Here is where your workspace stands today.'}
      />

      {overview && (
        <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Active members" value={overview.activeMembers} hint={overview.pendingInvites ? `${overview.pendingInvites} invitation(s) pending` : 'No pending invitations'} icon={<Users className="size-4" />} />
          <Stat label="Legal entities" value={overview.legalEntities} hint={`${overview.countries} countr${overview.countries === 1 ? 'y' : 'ies'}`} icon={<Globe2 className="size-4" />} />
          <Stat label="Locations" value={overview.locations} hint="Offices, plants and sites" icon={<MapPin className="size-4" />} />
          <Stat label="Departments" value={overview.departments} hint={`${overview.businessUnits} business unit(s)`} icon={<Network className="size-4" />} />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          {news && news.length > 0 && (
            <Card>
              <CardHeader title="Announcements" description={unreadNews.length ? `${unreadNews.length} need your attention` : 'You are up to date'} action={<Link href="/announcements" className={buttonClass('secondary', 'sm')}>All</Link>} />
              <ul className="divide-y divide-border">
                {news.slice(0, 4).map((a) => (
                  <li key={a.id} className="flex items-center gap-2 px-5 py-2.5 text-[13px]">
                    <Link href={`/announcements/${a.id}`} className="min-w-0 flex-1 truncate font-medium hover:text-accent hover:underline">{a.title}</Link>
                    {a.requiresAck && !a.acknowledgedAt ? <Badge tone="warning">Please acknowledge</Badge> : !a.readAt ? <Badge tone="info">New</Badge> : null}
                    <span className="shrink-0 text-xs text-fg-subtle">{a.publishedAt && dateTime(a.publishedAt)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {isAdmin && steps.length > 0 && (
            <Card>
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
          )}

          <Card>
            <CardHeader title="Your access" description="What your roles let you do in this workspace, and for whom." action={<ShieldCheck className="size-5 text-accent" />} />
            <CardBody>
              <div className="mb-4 flex flex-wrap gap-1.5">
                {me.membership.roles.map((r) => <Badge key={r.key} tone="accent">{r.name}</Badge>)}
              </div>
              {myAccess.length ? (
                <ul className="grid gap-2 sm:grid-cols-2">
                  {myAccess.map(({ def, scope }) => (
                    <li key={def!.key} className="flex items-start justify-between gap-3 rounded-md bg-bg-subtle/70 px-3 py-2">
                      <span className="text-[13px]">{def!.description}</span>
                      <span className="shrink-0 text-[11px] font-medium text-fg-subtle">{SCOPE_LABEL[scope]}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-fg-muted">Your self-service features appear here once your administrator gives you access.</p>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          {helpdesk && (
            <Card>
              <CardHeader title="Ask HR" action={<LifeBuoy className="size-5 text-accent" />} />
              <CardBody className="grid gap-2 text-[13px]">
                <div className="flex justify-between"><span className="text-fg-muted">Your open questions</span><span className="font-medium tabular-nums">{helpdesk.mine.open + helpdesk.mine.waiting}</span></div>
                {helpdesk.mine.waiting > 0 && <div className="flex justify-between"><span className="text-warning">Waiting for your reply</span><span className="font-medium tabular-nums">{helpdesk.mine.waiting}</span></div>}
                {helpdesk.mine.resolved > 0 && <div className="flex justify-between"><span className="text-fg-muted">Resolved, please confirm</span><span className="font-medium tabular-nums">{helpdesk.mine.resolved}</span></div>}
                {helpdesk.assignedToMe !== null && <div className="flex justify-between"><span className="text-fg-muted">Cases assigned to you</span><span className="font-medium tabular-nums">{helpdesk.assignedToMe}</span></div>}
                <div className="mt-2 flex gap-2">
                  <Link href="/helpdesk" className={buttonClass('secondary', 'sm')}>Ask a question</Link>
                  {helpdesk.assignedToMe !== null && <Link href="/helpdesk/queue" className={buttonClass('secondary', 'sm')}>Open queue</Link>}
                </div>
              </CardBody>
            </Card>
          )}
          <Card>
            <CardHeader title="Your plan" action={me.subscription && <Badge tone={me.subscription.status === 'trialing' ? 'info' : 'success'}>{me.subscription.status === 'trialing' ? 'Trial' : 'Active'}</Badge>} />
            <CardBody>
              <div className="text-2xl font-semibold capitalize">{me.subscription?.plan ?? 'None'}</div>
              <p className="mt-1 text-[13px] text-fg-muted">{me.features.length} of {FEATURES.filter((f) => f.kind === 'boolean').length} capabilities included{me.limits.max_employees > 0 ? `, up to ${me.limits.max_employees.toLocaleString()} people` : ', unlimited people'}.</p>
              {can(me, 'billing:read') && <Link href="/settings/billing" className={buttonClass('secondary', 'sm', 'mt-4')}>View plan</Link>}
            </CardBody>
          </Card>

          <Card className="overflow-hidden">
            <div className="bg-gradient-to-br from-accent-subtle to-ember-subtle px-5 py-4">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-accent"><Sparkles className="size-4" /> On the CREW roadmap</div>
              <p className="mt-0.5 text-xs text-fg-muted">This workspace runs the foundation release. Modules arrive in this order.</p>
            </div>
            <ul className="divide-y divide-border">
              {ROADMAP.map((r) => (
                <li key={r.phase} className="px-5 py-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-medium">{r.title}</span>
                    <span className="text-[11px] text-fg-subtle">Phase {r.phase}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-fg-muted">{r.items}</p>
                </li>
              ))}
            </ul>
          </Card>

          {!overview && (
            <Card className="p-5">
              <div className="flex items-center gap-2 text-[13px] text-fg-muted"><Building2 className="size-4" /> {me.tenant.name}</div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
