'use client';
import { FEATURES, SUBSCRIPTION_STATUSES, supportAccessRequest } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, Field, Input, Select, Stat, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { Eye, LifeBuoy, PauseCircle, PlayCircle, SlidersHorizontal } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { TenantDetail } from '@/lib/types';
import { overrideSubscriptionAction, requestSupportAccessAction, setTenantStatusAction } from '../../actions';

export interface SupportSnapshot {
  grantId: string;
  overview: { legalEntities: number; locations: number; departments: number; activeMembers: number };
  roles: { name: string; members: number }[];
  recentAudit: { action: string; actorLabel: string | null; createdAt: string }[];
}

type DialogKind = 'status' | 'subscription' | 'support' | null;
const BOOLEAN_FEATURES = (FEATURES as readonly { key: string; name: string; kind: string }[]).filter((f) => f.kind === 'boolean');

export function TenantView({ t, plans, snapshot, caps }: { t: TenantDetail; plans: { key: string; name: string }[]; snapshot: SupportSnapshot | null; caps: { manage: boolean; billing: boolean; support: boolean } }) {
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [flash, setFlash] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const s = t.subscription;
  const done = (r: { ok: boolean; message?: string }) => {
    setFlash({ tone: r.ok ? 'success' : 'danger', text: r.message ?? (r.ok ? 'Done.' : 'Something went wrong.') });
    if (r.ok) setDialog(null);
    return r.ok;
  };

  return (
    <div className="grid gap-6">
      {flash && <Alert tone={flash.tone}>{flash.text}</Alert>}
      {t.status !== 'active' && <Alert tone="danger" title={`This workspace is ${t.status}`}>{t.statusReason ?? 'No reason recorded.'}</Alert>}
      {t.isDemo && <Alert tone="info">This is a demo workspace with fictional data. It is excluded from revenue metrics.</Alert>}

      <div className="flex flex-wrap gap-2">
        {caps.manage && (t.status === 'active'
          ? <Button variant="danger" onClick={() => setDialog('status')}><PauseCircle className="size-4" /> Suspend</Button>
          : <Button onClick={() => setDialog('status')}><PlayCircle className="size-4" /> Reactivate</Button>)}
        {caps.billing && s && <Button variant="secondary" onClick={() => setDialog('subscription')}><SlidersHorizontal className="size-4" /> Adjust subscription</Button>}
        {caps.support && <Button variant="secondary" onClick={() => setDialog('support')}><LifeBuoy className="size-4" /> Request support access</Button>}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Plan" value={s?.planName ?? 'None'} hint={s ? <Badge tone={s.status === 'active' ? 'success' : s.status === 'trialing' ? 'accent' : 'warning'}>{s.status}{s.trialEndsOn ? ` to ${s.trialEndsOn}` : ''}</Badge> : undefined} />
        <Stat label="Members" value={`${t.activeMembers} / ${s?.seats ?? '—'}`} hint={`${t.pendingInvites} pending invitations`} />
        <Stat label="Legal entities" value={t.legalEntities} />
        <Stat label="Last activity" value={t.lastActivityAt ? new Date(t.lastActivityAt).toLocaleDateString() : 'Never'} hint={`${t.aiCreditsThisMonth} AI credits this month`} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Subscription" />
          <CardBody>
            {s ? (
              <dl className="grid grid-cols-2 gap-3 text-[13px]">
                <div><dt className="text-fg-subtle">Billing</dt><dd>{s.billingCycle}, {s.currency} {s.unitPrice} per seat per month</dd></div>
                <div><dt className="text-fg-subtle">Current period ends</dt><dd>{s.currentPeriodEnd ?? '—'}</dd></div>
                <div><dt className="text-fg-subtle">Payment provider</dt><dd>{s.provider === 'manual' ? 'Manual invoicing (no provider connected)' : s.provider}</dd></div>
                <div><dt className="text-fg-subtle">Workspace MFA policy</dt><dd>{t.requireMfa ? 'Required for everyone' : 'Optional'}</dd></div>
                <div className="col-span-2"><dt className="text-fg-subtle">Feature overrides</dt><dd>{Object.keys(s.featureOverrides ?? {}).length ? Object.entries(s.featureOverrides).map(([k, v]) => <Badge key={k} className="mr-1" tone={v === false ? 'danger' : 'accent'}>{k}: {String(v)}</Badge>) : 'None'}</dd></div>
              </dl>
            ) : <p className="text-sm text-fg-muted">No subscription.</p>}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Support access" description="Requests need approval by the customer's owner or admin." />
          {t.supportAccess.length === 0 ? <CardBody className="text-sm text-fg-muted">No requests yet.</CardBody> : (
            <Table>
              <THead><TR><TH>Requested</TH><TH>Status</TH><TH>Expires</TH></TR></THead>
              <TBody>
                {t.supportAccess.map((g) => {
                  const expired = g.status === 'approved' && g.expiresAt && new Date(g.expiresAt) < new Date();
                  const st = expired ? 'expired' : g.status;
                  return (
                    <TR key={g.id} title={g.reason}>
                      <TD><div className="whitespace-nowrap">{new Date(g.createdAt).toLocaleString()}</div><div className="text-xs text-fg-subtle">{g.requestedBy}</div></TD>
                      <TD><Badge tone={st === 'approved' ? 'success' : st === 'pending' ? 'warning' : 'neutral'}>{st}</Badge></TD>
                      <TD className="whitespace-nowrap text-fg-muted">{g.expiresAt ? new Date(g.expiresAt).toLocaleString() : '—'}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </Card>
      </div>

      {snapshot && (
        <Card className="ring-2 ring-warning/40">
          <CardHeader title={<span className="flex items-center gap-2"><Eye className="size-4" /> Support view (read-only)</span>} description="Visible because the customer approved your request. Opening it was written to the customer's audit trail." />
          <CardBody className="grid gap-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Legal entities" value={snapshot.overview.legalEntities} />
              <Stat label="Locations" value={snapshot.overview.locations} />
              <Stat label="Departments" value={snapshot.overview.departments} />
              <Stat label="Active members" value={snapshot.overview.activeMembers} />
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
              <div className="min-w-0">
                <h3 className="mb-2 text-sm font-semibold">Roles in use</h3>
                <ul className="grid gap-1 text-[13px]">{snapshot.roles.map((r) => <li key={r.name} className="flex justify-between"><span>{r.name}</span><span className="tabular text-fg-subtle">{r.members}</span></li>)}</ul>
              </div>
              <div className="min-w-0">
                <h3 className="mb-2 text-sm font-semibold">Recent activity</h3>
                <ul className="grid gap-2 text-[13px]">{snapshot.recentAudit.slice(0, 12).map((a, i) => <li key={i} className="min-w-0"><code className="text-xs">{a.action}</code><div className="truncate text-xs text-fg-subtle">{a.actorLabel ?? 'System'} · {new Date(a.createdAt).toLocaleString()}</div></li>)}</ul>
              </div>
            </div>
          </CardBody>
        </Card>
      )}

      {dialog === 'status' && <StatusDialog t={t} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'subscription' && s && <SubscriptionDialog t={t} plans={plans} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'support' && <SupportDialog t={t} onClose={() => setDialog(null)} onDone={done} />}
    </div>
  );
}

type Done = (r: { ok: boolean; message?: string }) => boolean;

function StatusDialog({ t, onClose, onDone }: { t: TenantDetail; onClose: () => void; onDone: Done }) {
  const router = useRouter();
  const suspend = t.status === 'active';
  const [reason, setReason] = useState('');
  const [pending, start] = useTransition();
  const tooShort = reason.trim().length < 5;
  return (
    <Dialog open onClose={onClose} title={suspend ? `Suspend ${t.name}?` : `Reactivate ${t.name}?`}
      description={suspend ? 'Everyone in this workspace is signed out immediately and cannot sign in until it is reactivated. Data is kept.' : 'Members will be able to sign in again.'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={suspend ? 'danger' : 'primary'} disabled={tooShort} loading={pending} onClick={() => start(async () => {
        const r = await setTenantStatusAction(t.id, suspend ? 'suspended' : 'active', reason.trim());
        if (onDone(r)) router.refresh();
      })}>{suspend ? 'Suspend workspace' : 'Reactivate'}</Button></>}>
      <Field label="Reason" hint="Recorded in the platform audit log and shown to SAMPLEDGE staff." error={reason && tooShort ? 'At least 5 characters' : undefined} required>
        {(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />}
      </Field>
    </Dialog>
  );
}

function SubscriptionDialog({ t, plans, onClose, onDone }: { t: TenantDetail; plans: { key: string; name: string }[]; onClose: () => void; onDone: Done }) {
  const router = useRouter();
  const s = t.subscription!;
  const [planKey, setPlanKey] = useState(s.plan);
  const [status, setStatus] = useState(s.status);
  const [seats, setSeats] = useState(String(s.seats));
  const [trialEndsOn, setTrialEndsOn] = useState(s.trialEndsOn ?? '');
  const [overrides, setOverrides] = useState<Record<string, boolean | number>>(s.featureOverrides ?? {});
  const [pending, start] = useTransition();
  const n = Number(seats);
  const seatsError = !Number.isInteger(n) || n < 1 ? 'Whole number, at least 1' : undefined;
  const cycleOverride = (key: string) => {
    const next = { ...overrides };
    if (next[key] === undefined) next[key] = true;
    else if (next[key] === true) next[key] = false;
    else delete next[key];
    setOverrides(next);
  };
  return (
    <Dialog open onClose={onClose} size="lg" title="Adjust subscription" description="Commercial overrides for this customer. Every change is recorded in both audit logs."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={Boolean(seatsError)} loading={pending} onClick={() => start(async () => {
        const r = await overrideSubscriptionAction(t.id, { planKey, status, seats: n, trialEndsOn: trialEndsOn || null, featureOverrides: overrides });
        if (onDone(r)) router.refresh();
      })}>Save</Button></>}>
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Plan">{(p) => <Select {...p} value={planKey} onChange={(e) => setPlanKey(e.target.value)}>{plans.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}</Select>}</Field>
          <Field label="Status">{(p) => <Select {...p} value={status} onChange={(e) => setStatus(e.target.value)}>{SUBSCRIPTION_STATUSES.map((x) => <option key={x}>{x}</option>)}</Select>}</Field>
          <Field label="Seats" error={seatsError}>{(p) => <Input {...p} type="number" min={1} value={seats} onChange={(e) => setSeats(e.target.value)} />}</Field>
          <Field label="Trial ends on" hint="Leave empty for no trial">{(p) => <Input {...p} type="date" value={trialEndsOn} onChange={(e) => setTrialEndsOn(e.target.value)} />}</Field>
        </div>
        <div>
          <div className="mb-1 text-[13px] font-medium">Feature overrides</div>
          <p className="mb-2 text-xs text-fg-subtle">Click to cycle: plan default, force on, force off.</p>
          <div className="flex flex-wrap gap-1.5">
            {BOOLEAN_FEATURES.map((f) => {
              const v = overrides[f.key];
              return (
                <button key={f.key} type="button" onClick={() => cycleOverride(f.key)} title={f.name}
                  className={`rounded-full border px-2.5 py-1 text-xs ${v === true ? 'border-success bg-success-subtle text-success' : v === false ? 'border-danger bg-danger-subtle text-danger' : 'border-border text-fg-muted hover:bg-bg-subtle'}`}>
                  {f.name}{v === true ? ' · on' : v === false ? ' · off' : ''}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function SupportDialog({ t, onClose, onDone }: { t: TenantDetail; onClose: () => void; onDone: Done }) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState('60');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  return (
    <Dialog open onClose={onClose} title="Request support access" description={`${t.name}'s owner or admin must approve this in CREW. Access ends automatically when the time runs out.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={() => {
        const parsed = supportAccessRequest.safeParse({ reason, durationMinutes: Number(minutes) });
        if (!parsed.success) { setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message]))); return; }
        start(async () => {
          const r = await requestSupportAccessAction(t.id, parsed.data.reason, parsed.data.durationMinutes);
          if (onDone(r.ok ? { ok: true, message: r.data!.note } : r)) router.refresh();
        });
      }}>Send request</Button></>}>
      <div className="grid gap-4">
        <Field label="Reason (shown to the customer)" error={errors.reason} required>{(p) => <Textarea {...p} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Ticket #1234: investigating why invitations are not arriving" />}</Field>
        <Field label="Duration" error={errors.durationMinutes}>{(p) => (
          <Select {...p} value={minutes} onChange={(e) => setMinutes(e.target.value)}>
            <option value="30">30 minutes</option><option value="60">1 hour</option><option value="120">2 hours</option><option value="240">4 hours</option><option value="480">8 hours</option>
          </Select>
        )}</Field>
      </div>
    </Dialog>
  );
}
