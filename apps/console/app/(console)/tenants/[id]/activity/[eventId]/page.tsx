import { PLATFORM_ROLE_CAPABILITIES, type ActivityEventDetail } from '@crew/contracts';
import { Alert, Badge, buttonClass, Card, CardBody, CardHeader, EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { ArrowLeft, Eye, FileClock } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { WorkspaceTabs } from '@/components/neon';
import { ApiError, load } from '@/lib/api';
import type { Admin, TenantDetail } from '@/lib/types';

export const metadata: Metadata = { title: 'Activity event' };

const ACTOR: Record<string, string> = { user: 'Person', platform_admin: 'SAMPLEDGE', system: 'System', ai_agent: 'AI', integration: 'Integration' };

/** A recorded value as text: strings as they are, empty as a dash, anything else as compact JSON. */
function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

const isDiff = (v: unknown): v is { from: unknown; to: unknown } => !!v && typeof v === 'object' && !Array.isArray(v) && 'from' in v && 'to' in v && Object.keys(v).length === 2;

/** Changed fields as rows: before and after for a change, or the recorded value. */
function ChangesTable({ changes, label }: { changes: Record<string, unknown>; label: string }) {
  const entries = Object.entries(changes);
  const anyDiff = entries.some(([, v]) => isDiff(v));
  return (
    <Table aria-label={label}>
      <THead><TR><TH>Field</TH>{anyDiff ? <><TH>Before</TH><TH>After</TH></> : <TH>Value</TH>}</TR></THead>
      <TBody>
        {entries.map(([k, v]) => (
          <TR key={k}>
            <TD className="whitespace-nowrap font-mono text-xs">{k}</TD>
            {isDiff(v) ? (
              <><TD className="break-all text-fg-muted">{show(v.from)}</TD><TD className="break-all font-medium">{show(v.to)}</TD></>
            ) : anyDiff ? (
              <TD colSpan={2} className="break-all">{show(v)}</TD>
            ) : (
              <TD className="break-all">{show(v)}</TD>
            )}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

/** Compact one-line summary of a history event's contents. */
function summary(changes: Record<string, unknown>) {
  const parts = Object.entries(changes).map(([k, v]) => (isDiff(v) ? `${k}: ${show(v.from)} → ${show(v.to)}` : `${k}: ${show(v)}`));
  const text = parts.join('; ');
  return text.length > 220 ? `${text.slice(0, 220)}…` : text || '—';
}

export default async function ActivityEventPage({ params }: { params: Promise<{ id: string; eventId: string }> }) {
  const { id, eventId } = await params;
  if (!/^[1-9]\d{0,17}$/.test(eventId)) notFound();
  // Loading the event is what records the read in the customer's trail, so it happens once per page view.
  const [me, t, ev] = await Promise.all([
    load<Admin>('/platform/auth/me'),
    load<TenantDetail>(`/platform/tenants/${id}`),
    load<ActivityEventDetail>(`/platform/tenants/${id}/activity/${eventId}`).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 404) notFound();
      throw e;
    }),
  ]);
  const changes = ev.changes ?? {};
  const metadata = ev.metadata ?? {};
  return (
    <>
      <PageHeader
        eyebrow={<><Link href="/tenants" className="hover:underline">Workspaces</Link> / <Link href={`/tenants/${id}`} className="hover:underline">{t.name}</Link> / <Link href={`/tenants/${id}/activity`} className="hover:underline">Activity</Link></>}
        title={<code className="text-[1.05em]">{ev.action}</code>}
        description={`${new Date(ev.createdAt).toLocaleString()} · ${ev.actorLabel ?? ACTOR[ev.actorType] ?? ev.actorType} · ${ev.resourceType}${ev.resourceId ? ` ${ev.resourceId}` : ''}`}
        actions={<Link className={buttonClass('secondary')} href={`/tenants/${id}/activity`}><ArrowLeft className="size-4" aria-hidden />All activity</Link>}
      />
      <WorkspaceTabs tenantId={id} current="activity" caps={[...(PLATFORM_ROLE_CAPABILITIES[me.role] ?? [])]} />
      <Alert tone="info" title="This view is recorded" className="mb-6">
        <span className="inline-flex items-center gap-1.5"><Eye className="size-3.5" aria-hidden />Opening this event was written to the customer&apos;s activity trail and the SAMPLEDGE audit log, with your name.</span>
      </Alert>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <CardHeader title="What changed" />
          {Object.keys(changes).length === 0
            ? <EmptyState icon={<FileClock className="size-6" />} title="No values were recorded for this event" />
            : <ChangesTable changes={changes} label="What changed" />}
        </Card>
        <Card>
          <CardHeader title="Details" />
          <CardBody>
            <dl className="grid gap-3 text-[13px]">
              <div><dt className="text-fg-subtle">Who</dt><dd>{ev.actorLabel ?? '—'} <Badge>{ACTOR[ev.actorType] ?? ev.actorType}</Badge></dd></div>
              <div><dt className="text-fg-subtle">App</dt><dd>{ev.client === 'mobile' ? 'Mobile app' : ev.client === 'web' ? 'Web Portal' : '—'}</dd></div>
              <div><dt className="text-fg-subtle">Address</dt><dd className="font-mono text-xs">{ev.ip ?? '—'}</dd></div>
              <div><dt className="text-fg-subtle">Browser or device</dt><dd className="break-all text-xs">{ev.userAgent ?? '—'}</dd></div>
              <div><dt className="text-fg-subtle">Request</dt><dd className="break-all font-mono text-xs">{ev.requestId ?? '—'}</dd></div>
              {Object.entries(metadata).filter(([k]) => k !== 'client').map(([k, v]) => (
                <div key={k}><dt className="text-fg-subtle">{k}</dt><dd className="break-all">{show(v)}</dd></div>
              ))}
            </dl>
          </CardBody>
        </Card>
      </div>
      <Card className="mt-6">
        <CardHeader title="History of this record" description={ev.resourceId ? `Other events on ${ev.resourceType} ${ev.resourceId}, newest first.` : 'This event is not about one record.'} />
        {ev.history.length === 0 ? <EmptyState icon={<FileClock className="size-6" />} title="No other events on this record" /> : (
          <Table aria-label="History of this record">
            <THead><TR><TH>When</TH><TH>What</TH><TH>Who</TH><TH>Changes</TH></TR></THead>
            <TBody>
              {ev.history.map((h) => (
                <TR key={h.id}>
                  <TD className="whitespace-nowrap text-fg-muted">{new Date(h.createdAt).toLocaleString()}</TD>
                  <TD><Link className="hover:underline" href={`/tenants/${id}/activity/${h.id}`}><code className="text-xs">{h.action}</code></Link></TD>
                  <TD className="whitespace-nowrap">{h.actorLabel ?? ACTOR[h.actorType] ?? h.actorType}</TD>
                  <TD className="max-w-[32rem] text-xs text-fg-muted">{summary(h.changes ?? {})}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}
