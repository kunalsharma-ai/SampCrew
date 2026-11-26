import { PERMISSIONS, type ActivityLog } from '@crew/contracts';
import { Badge, Card, CardHeader, EmptyState, PageHeader } from '@crew/ui';
import { History } from 'lucide-react';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { Me } from '@/lib/types';

export const metadata: Metadata = { title: 'Activity log' };

const SCOPE_LABEL: Record<string, string> = { own: 'Yourself', team: 'Your team', department: 'Your department', entity: 'Your legal entity', tenant: 'Whole organization' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "Chrome on Windows" from a user agent, or the app. */
function device(client: string, ua: string | null): string {
  if (client === 'mobile') return 'SampCrew phone app';
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/** audit action "leave.request_created" as "Leave: request created". */
function actionLabel(action: string) {
  const [area, ...rest] = action.split('.');
  const words = rest.join(' ').replace(/_/g, ' ');
  const a = (area ?? '').replace(/_/g, ' ');
  return `${a[0]?.toUpperCase() ?? ''}${a.slice(1)}${words ? `: ${words}` : ''}`;
}

/**
 * Activity log (issue #86): every sign-in with its time, IP address, device and GPS position, and what was done in
 * that session. Super Workspace and HR Workspace people who may read the audit trail pick anyone; everyone else sees
 * their own. "Your access" moved here from Home.
 */
export default async function ActivityPage({ searchParams }: { searchParams: Promise<{ member?: string }> }) {
  const sp = await searchParams;
  const member = sp.member && uuid.test(sp.member) ? sp.member : undefined;
  const [me, log] = await Promise.all([load<Me>('/me'), load<ActivityLog>(`/activity${member ? `?membershipId=${member}` : ''}`)]);
  const fmt = (iso: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: me.tenant.timezone }).format(new Date(iso));
  const time = (iso: string) => new Intl.DateTimeFormat('en-IN', { timeStyle: 'short', timeZone: me.tenant.timezone }).format(new Date(iso));
  const access = log.self
    ? Object.entries(me.permissions).map(([key, scope]) => ({ key, def: PERMISSIONS.find((p) => p.key === key), scope })).filter((x) => x.def)
    : [];
  return (
    <>
      <PageHeader
        title="Activity log"
        description={log.self ? 'Your sign-ins: when, from which network (IP address), device and location, and what you did in each session.' : `${log.person.name}'s sign-ins: when, from which network (IP address), device and location, and what was done in each session.`}
        actions={log.canViewOthers && log.people.length > 0 ? (
          <form action="/activity" className="flex items-end gap-2 text-[0.8125rem]">
            <label className="grid gap-0.5"><span className="text-fg-subtle">Person</span>
              <select name="member" defaultValue={log.person.membershipId} className="h-9 rounded-md border border-border bg-surface px-2" data-testid="activity-person">
                {log.people.map((p) => <option key={p.membershipId} value={p.membershipId}>{p.name}{p.membershipId === me.membership.id ? ' (you)' : ''}</option>)}
              </select>
            </label>
            <button type="submit" className="h-9 rounded-md border border-border px-3 font-medium hover:bg-bg-subtle">Show</button>
          </form>
        ) : undefined}
      />
      <div className="grid grid-cols-1 gap-5">
        {log.sessions.length === 0 ? (
          <Card><EmptyState icon={<History className="size-5" />} title="No sign-ins yet" description="Sign-ins show here with their IP address, device and location." /></Card>
        ) : (
          <ol className="grid grid-cols-1 gap-4" data-testid="activity-sessions">
            {log.sessions.map((s) => (
              <li key={s.id}>
                <Card data-testid="activity-session">
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-[0.875rem] font-semibold">
                        Signed in {fmt(s.startedAt)}
                        {s.current && <Badge tone="info">This session</Badge>}
                        <Badge tone={s.status === 'active' ? 'success' : 'neutral'}>{s.status === 'active' ? 'Open' : s.status === 'expired' ? 'Expired' : `Signed out${s.endedAt ? ` ${time(s.endedAt)}` : ''}`}</Badge>
                      </div>
                      <div className="mt-0.5 text-[0.75rem] text-fg-muted">{device(s.client, s.userAgent)} · Last active {fmt(s.lastActiveAt)}</div>
                    </div>
                    <dl className="grid grid-cols-2 gap-x-6 gap-y-0.5 text-[0.75rem]">
                      <dt className="text-fg-subtle">IP address</dt><dd className="font-mono" data-testid="activity-ip">{s.ip ?? 'Not recorded'}</dd>
                      <dt className="text-fg-subtle">GPS</dt>
                      <dd data-testid="activity-gps">
                        {s.location.status === 'shared' && s.location.latitude !== null
                          ? <a className="font-mono text-accent hover:underline" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${s.location.latitude}&mlon=${s.location.longitude}#map=16/${s.location.latitude}/${s.location.longitude}`}>{s.location.latitude.toFixed(5)}, {s.location.longitude!.toFixed(5)}</a>
                          : s.location.status === 'denied' ? 'Not shared (refused)' : s.location.status === 'unavailable' ? 'Not available' : 'Not asked'}
                        {s.location.accuracyM ? <span className="text-fg-subtle"> ±{s.location.accuracyM} m</span> : null}
                      </dd>
                    </dl>
                  </div>
                  <div className="px-5 py-3">
                    <div className="mb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-fg-subtle">Done in this session ({s.actions.length}{s.actions.length === 100 ? '+' : ''})</div>
                    {s.actions.length === 0 ? <p className="text-[0.8125rem] text-fg-muted">Nothing changed in this session.</p> : (
                      <ul className="grid grid-cols-1 gap-0.5 text-[0.8125rem]" data-testid="activity-actions">
                        {s.actions.map((a, i) => (
                          <li key={i} className="flex gap-3"><span className="w-16 shrink-0 tabular text-fg-subtle">{time(a.at)}</span><span className="min-w-0 flex-1 truncate">{actionLabel(a.action)}{a.resourceType ? <span className="text-fg-subtle"> · {a.resourceType.replace(/_/g, ' ')}</span> : null}</span></li>
                        ))}
                      </ul>
                    )}
                  </div>
                </Card>
              </li>
            ))}
          </ol>
        )}
        {access.length > 0 && (
          <Card data-testid="activity-access">
            <CardHeader title="Your access" description="What your workspace level lets you do, and for whom." />
            <ul className="grid grid-cols-1 gap-x-6 gap-y-1 px-5 pb-5 text-[0.8125rem] sm:grid-cols-2">
              {access.map((a) => <li key={a.key} className="flex justify-between gap-3 border-b border-border/60 py-1"><span>{a.def!.description}</span><span className="shrink-0 text-fg-subtle">{SCOPE_LABEL[a.scope] ?? a.scope}</span></li>)}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
