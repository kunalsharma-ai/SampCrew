'use client';
import { SUBSCRIPTION_STATUSES, supportAccessRequest } from '@crew/contracts';
import { Alert, Badge, Button, buttonClass, Card, CardBody, CardHeader, Dialog, Field, Input, Select, Stat, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { Activity, CreditCard, Eye, LifeBuoy, PauseCircle, PlayCircle, SlidersHorizontal, ToggleRight, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Tile, TileRow } from '@/components/neon';
import type { HistoryRow, PlanSummary, TenantDetail } from '@/lib/types';
import { overrideSubscriptionAction, requestSupportAccessAction, setTenantStatusAction } from '../../actions';

export interface SupportSnapshot {
  grantId: string;
  overview: { legalEntities: number; locations: number; departments: number; activeMembers: number };
  roles: { name: string; members: number }[];
  recentAudit: { action: string; actorLabel: string | null; createdAt: string }[];
}

type DialogKind = 'status' | 'subscription' | 'support' | null;

const LIMITS = [
  { key: 'max_employees', label: 'Employees included' },
  { key: 'max_legal_entities', label: 'Legal entities' },
  { key: 'ai_credits_monthly', label: 'AI credits per month' },
  { key: 'storage_gb', label: 'Document storage (GB)' },
] as const;

const HISTORY_LABEL: Record<string, string> = {
  'platform.subscription_overridden': 'Subscription changed',
  'platform.access_modules_switched': 'Modules switched',
  'platform.tenant_suspended': 'Workspace suspended',
  'platform.tenant_reactivated': 'Workspace reactivated',
  'platform.tenant_created': 'Workspace created',
};

const describe = (changes: Record<string, unknown>) =>
  Object.entries(changes).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ').slice(0, 220);

export function TenantView({ t, plans, history, snapshot, caps }: { t: TenantDetail; plans: PlanSummary[]; history: HistoryRow[]; snapshot: SupportSnapshot | null; caps: { manage: boolean; billing: boolean; support: boolean } }) {
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
        <Link href={`/tenants/${t.id}/access`} className={buttonClass('secondary')} data-testid="open-access"><ToggleRight className="size-4" /> Features &amp; permissions</Link>
      </div>

      <TileRow>
        <Tile tone="violet" icon={<CreditCard className="size-5" />} label="Plan" value={s?.planName ?? 'None'} hint={s ? `${s.status}${s.trialEndsOn ? ` to ${s.trialEndsOn}` : ''} · ${s.billingCycle}` : undefined} testId="tile-plan" />
        <Tile tone="teal" icon={<Users className="size-5" />} label="Members" value={`${t.activeMembers} / ${s?.seats ?? '—'}`} hint={`${t.pendingInvites} pending invitations`} href={`/tenants/${t.id}/users`} />
        <Tile tone="orange" icon={<ToggleRight className="size-5" />} label="Module switches" value={Object.values(s?.featureOverrides ?? {}).filter((v) => typeof v === 'boolean').length} hint="Set by SAMPLEDGE" href={`/tenants/${t.id}/access`} />
        <Tile tone="blue" icon={<Activity className="size-5" />} label="Last activity" value={t.lastActivityAt ? new Date(t.lastActivityAt).toLocaleDateString() : 'Never'} hint={`${t.aiCreditsThisMonth} AI credits this month`} href={`/tenants/${t.id}/activity`} />
      </TileRow>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Subscription" />
          <CardBody>
            {s ? (
              <dl className="grid grid-cols-2 gap-3 text-[13px]">
                <div><dt className="text-fg-subtle">Billing</dt><dd data-testid="sub-billing">{s.billingCycle}, {s.currency} {s.unitPrice} per seat per month</dd></div>
                <div><dt className="text-fg-subtle">Current period</dt><dd data-testid="sub-period">{s.currentPeriodStart ?? '—'} to {s.currentPeriodEnd ?? '—'}{s.cancelAtPeriodEnd ? ' (cancels at the end)' : ''}</dd></div>
                <div className="col-span-2"><dt className="text-fg-subtle">Limits</dt><dd className="flex flex-wrap gap-1">{LIMITS.map((l) => {
                  const own = s.featureOverrides?.[l.key];
                  const plan = plans.find((p) => p.key === s.plan)?.features.find((f) => f.key === l.key)?.limitValue;
                  const v = typeof own === 'number' ? own : plan;
                  return <Badge key={l.key} tone={typeof own === 'number' ? 'accent' : 'neutral'}>{l.label}: {v === -1 ? 'unlimited' : v ?? '—'}{typeof own === 'number' ? ' (custom)' : ''}</Badge>;
                })}</dd></div>
                <div><dt className="text-fg-subtle">Payment provider</dt><dd>{s.provider === 'manual' ? 'Manual invoicing (no provider connected)' : s.provider}</dd></div>
                <div><dt className="text-fg-subtle">Workspace MFA policy</dt><dd>{t.requireMfa ? 'Required for everyone' : 'Optional'}</dd></div>
                <div className="col-span-2"><dt className="text-fg-subtle">Module switches</dt><dd>{Object.values(s.featureOverrides ?? {}).some((v) => typeof v === 'boolean') ? Object.entries(s.featureOverrides).filter(([, v]) => typeof v === 'boolean').map(([k, v]) => <Badge key={k} className="mr-1" tone={v === false ? 'danger' : 'accent'}>{k}: {v === true ? 'on' : v === false ? 'off' : String(v)}</Badge>) : 'All modules follow the plan'}</dd></div>
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

      {history.length > 0 && (
        <Card>
          <CardHeader title="Subscription history" description="Every change SAMPLEDGE made to this workspace's plan, status, price and modules." />
          <Table aria-label="Subscription history">
            <THead><TR><TH>When</TH><TH>Change</TH><TH>By</TH><TH>Details</TH></TR></THead>
            <TBody>
              {history.slice(0, 15).map((h) => (
                <TR key={h.id}>
                  <TD className="whitespace-nowrap text-fg-muted">{new Date(h.createdAt).toLocaleString()}</TD>
                  <TD>{HISTORY_LABEL[h.action] ?? h.action}</TD>
                  <TD className="text-fg-muted">{h.actorLabel ?? 'System'}</TD>
                  <TD className="max-w-md truncate text-xs text-fg-muted" title={describe(h.changes)}>{describe(h.changes) || '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

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

function SubscriptionDialog({ t, plans, onClose, onDone }: { t: TenantDetail; plans: PlanSummary[]; onClose: () => void; onDone: Done }) {
  const router = useRouter();
  const s = t.subscription!;
  const [planKey, setPlanKey] = useState(s.plan);
  const [status, setStatus] = useState(s.status);
  const [seats, setSeats] = useState(String(s.seats));
  const [trialEndsOn, setTrialEndsOn] = useState(s.trialEndsOn ?? '');
  const [billingCycle, setBillingCycle] = useState(s.billingCycle);
  const [unitPrice, setUnitPrice] = useState(s.unitPrice);
  const [periodEnd, setPeriodEnd] = useState(s.currentPeriodEnd ?? '');
  const [cancelAtEnd, setCancelAtEnd] = useState(s.cancelAtPeriodEnd);
  const [limits, setLimits] = useState<Record<string, string>>(() => Object.fromEntries(LIMITS.map((l) => [l.key, typeof s.featureOverrides?.[l.key] === 'number' ? String(s.featureOverrides[l.key]) : ''])));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const n = Number(seats);
  const seatsError = !Number.isInteger(n) || n < 1 ? 'Whole number, at least 1' : undefined;
  const priceError = /^\d{1,8}(\.\d{1,2})?$/.test(unitPrice) ? undefined : 'A price such as 6.40';
  const limitErrors = Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== '' && !/^-?\d+$/.test(v)).map(([k]) => [k, 'Whole number, or -1 for unlimited']));
  const planLimit = (key: string) => plans.find((p) => p.key === planKey)?.features.find((f) => f.key === key)?.limitValue;
  return (
    <Dialog open onClose={onClose} size="lg" title="Adjust subscription" description="Commercial overrides for this customer. Every change is recorded in both audit logs."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={Boolean(seatsError || priceError || Object.keys(limitErrors).length)} loading={pending} onClick={() => start(async () => {
        setError(null);
        const changedLimits = Object.fromEntries(LIMITS.flatMap((l) => {
          const before = typeof s.featureOverrides?.[l.key] === 'number' ? String(s.featureOverrides[l.key]) : '';
          return limits[l.key] === before ? [] : [[l.key, limits[l.key] === '' ? null : Number(limits[l.key])]];
        }));
        const r = await overrideSubscriptionAction(t.id, {
          planKey, status, seats: n, trialEndsOn: trialEndsOn || null, billingCycle, unitPrice, cancelAtPeriodEnd: cancelAtEnd,
          ...(periodEnd && periodEnd !== s.currentPeriodEnd ? { currentPeriodEnd: periodEnd } : {}),
          ...(Object.keys(changedLimits).length ? { limits: changedLimits } : {}),
        });
        if (!r.ok) setError(r.message ?? 'Could not save.');
        if (onDone(r)) router.refresh();
      })}>Save</Button></>}>
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Plan">{(p) => <Select {...p} value={planKey} onChange={(e) => setPlanKey(e.target.value)}>{plans.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}</Select>}</Field>
          <Field label="Status">{(p) => <Select {...p} value={status} onChange={(e) => setStatus(e.target.value)}>{SUBSCRIPTION_STATUSES.map((x) => <option key={x}>{x}</option>)}</Select>}</Field>
          <Field label="Seats" error={seatsError}>{(p) => <Input {...p} type="number" min={1} value={seats} onChange={(e) => setSeats(e.target.value)} />}</Field>
          <Field label="Trial ends on" hint="Leave empty for no trial">{(p) => <Input {...p} type="date" value={trialEndsOn} onChange={(e) => setTrialEndsOn(e.target.value)} />}</Field>
          <Field label="Billing cycle">{(p) => <Select {...p} value={billingCycle} onChange={(e) => setBillingCycle(e.target.value)}><option value="monthly">Monthly</option><option value="annual">Annual</option></Select>}</Field>
          <Field label={`Price per seat per month (${s.currency})`} error={priceError} hint="A negotiated price for this customer">{(p) => <Input {...p} inputMode="decimal" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />}</Field>
          <Field label="Current period ends" hint={`Started ${s.currentPeriodStart ?? '—'}`}>{(p) => <Input {...p} type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />}</Field>
          <Field label="At the end of the period">{(p) => <Select {...p} value={cancelAtEnd ? 'cancel' : 'renew'} onChange={(e) => setCancelAtEnd(e.target.value === 'cancel')}><option value="renew">Renew</option><option value="cancel">Cancel</option></Select>}</Field>
        </div>
        <fieldset className="grid gap-3 rounded-lg border border-border p-3">
          <legend className="px-1 text-[13px] font-medium">Limits for this customer</legend>
          <p className="text-xs text-fg-subtle">Leave empty to use the plan&apos;s limit. -1 is unlimited.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {LIMITS.map((l) => {
              const pl = planLimit(l.key);
              return (
                <Field key={l.key} label={l.label} error={limitErrors[l.key]} hint={`Plan: ${pl === -1 ? 'unlimited' : pl ?? '—'}`}>
                  {(p) => <Input {...p} inputMode="numeric" value={limits[l.key]} placeholder="Plan limit" onChange={(e) => setLimits((x) => ({ ...x, [l.key]: e.target.value.trim() }))} />}
                </Field>
              );
            })}
          </div>
        </fieldset>
        <p className="text-xs text-fg-subtle">Modules and permissions are switched on the <Link href={`/tenants/${t.id}/access`} className="text-accent hover:underline">Features &amp; permissions</Link> page.</p>
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
    <Dialog open onClose={onClose} title="Request support access" description={`${t.name}'s owner or admin must approve this in SampCrew. Access ends automatically when the time runs out.`}
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
