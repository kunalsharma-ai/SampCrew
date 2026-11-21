'use client';
import {
  describeMobileChanges, MOBILE_LEVEL_LABEL, MOBILE_LEVELS, MOBILE_MAX_TABS, MOBILE_MODULES, MOBILE_QUICK_ACTIONS, MOBILE_WIDGETS, type MobileAppConfig, type MobileLevel,
  type MobileModuleDef, mobileKeyOn, resolveMobileApp, validateMobileConfig,
} from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, cn, Dialog, Input, Select, Switch, Textarea } from '@crew/ui';
import {
  ArrowDown, ArrowUp, Bell, BookOpen, CalendarDays, CheckCheck, ChevronDown, Clock, FileText, Fingerprint, HelpCircle, History, Home, LayoutGrid, List, type LucideIcon, Mail,
  Megaphone, MessagesSquare, MoreHorizontal, PieChart, Plane, Search, ShieldCheck, Smartphone, Sun, UserCircle, Users, Wallet, Award, Hourglass, BarChart3,
} from 'lucide-react';
import { useMemo, useState, useTransition } from 'react';
import { type MobileAppVersion, discardMobileDraftAction, mobileVersionsAction, publishMobileAction, restoreMobileVersionAction, saveMobileDraftAction } from './actions';
import type { MobileAppOverview } from './types';

/** The phone uses Ionicons; the Web Portal shows the closest Lucide icon. */
const ICON: Record<string, LucideIcon> = {
  home: Home, time: Clock, sunny: Sun, chatbubbles: MessagesSquare, mail: Mail, 'document-text': FileText, school: BookOpen, megaphone: Megaphone, notifications: Bell,
  'checkmark-done': CheckCheck, list: List, ribbon: Award, wallet: Wallet, 'help-buoy': HelpCircle, people: Users, 'person-circle': UserCircle, 'shield-checkmark': ShieldCheck,
  'finger-print': Fingerprint, airplane: Plane, calendar: CalendarDays, 'pie-chart': PieChart, hourglass: Hourglass, 'stats-chart': BarChart3, search: Search,
};
const Icon = ({ name, className }: { name: string; className?: string }) => {
  const I = ICON[name] ?? LayoutGrid;
  return <I className={className ?? 'size-4'} aria-hidden />;
};
const MODULES = MOBILE_MODULES as readonly MobileModuleDef[];
const LEVEL_SHORT: Record<MobileLevel, string> = { super: 'Super', hr: 'HR', employee: 'Employee' };
type Tab = 'modules' | 'home' | 'history';
type Msg = { tone: 'success' | 'danger' | 'warning'; text: string } | null;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

export function MobileAppManager({ initial, initialVersions }: { initial: MobileAppOverview; initialVersions: MobileAppVersion[] }) {
  const [overview, setOverview] = useState(initial);
  const [config, setConfig] = useState<MobileAppConfig>(initial.draft.config);
  const [versions, setVersions] = useState(initialVersions);
  const [tab, setTab] = useState<Tab>('modules');
  const [level, setLevel] = useState<MobileLevel>('employee');
  const [msg, setMsg] = useState<Msg>(null);
  const [publishing, setPublishing] = useState(false);
  const [restoring, setRestoring] = useState<MobileAppVersion | null>(null);
  const [pending, start] = useTransition();

  const available = useMemo(() => new Set(overview.catalogue.filter((c) => c.available).map((c) => c.key)), [overview.catalogue]);
  // The entitlement keys the company has, so the preview and the checks know what the plan includes.
  const features = useMemo(() => new Set(MODULES.filter((m) => available.has(m.key) && m.entitlement).map((m) => m.entitlement!)), [available]);
  const issues = useMemo(() => validateMobileConfig(config, { features }), [config, features]);
  const errors = issues.filter((i) => i.severity === 'error');
  const unsaved = JSON.stringify(config) !== JSON.stringify(overview.draft.config);
  const changes = useMemo(() => describeMobileChanges(overview.published.config, config), [overview.published.config, config]);
  const preview = useMemo(() => resolveMobileApp({ config, version: overview.published.version + (changes.length ? 1 : 0), publishedAt: null, level, features }), [config, level, features, overview.published.version, changes.length]);

  const refresh = (o: MobileAppOverview) => {
    setOverview(o);
    setConfig(o.draft.config);
  };
  const update = (fn: (c: MobileAppConfig) => void) => setConfig((cur) => {
    const next = structuredClone(cur);
    fn(next);
    return next;
  });
  const save = () => start(async () => {
    const r = await saveMobileDraftAction(config);
    setMsg(r.ok ? { tone: 'success', text: r.message ?? 'Draft saved.' } : { tone: 'danger', text: r.message });
    if (r.ok && r.data) refresh(r.data);
  });
  const discard = () => start(async () => {
    const r = await discardMobileDraftAction();
    setMsg(r.ok ? { tone: 'success', text: 'Draft discarded. The editor shows the published version again.' } : { tone: 'danger', text: r.message });
    if (r.ok && r.data) refresh(r.data);
  });
  const reloadVersions = async () => {
    const v = await mobileVersionsAction();
    if (v.ok && v.data) setVersions(v.data);
  };

  const sorted = [...MODULES].sort((a, b) => (config.modules[a.key]?.order ?? 0) - (config.modules[b.key]?.order ?? 0));
  const move = (key: string, dir: -1 | 1) => update((c) => {
    const keys = [...MODULES].sort((a, b) => c.modules[a.key]!.order - c.modules[b.key]!.order).map((m) => m.key);
    const i = keys.indexOf(key);
    const j = i + dir;
    if (j < 0 || j >= keys.length) return;
    [keys[i], keys[j]] = [keys[j]!, keys[i]!];
    keys.forEach((k, n) => (c.modules[k]!.order = n * 10));
  });
  const statusBadge = overview.stats.status === 'default'
    ? <Badge tone="neutral" dot>Starting configuration</Badge>
    : overview.stats.status === 'draft_pending' ? <Badge tone="warning" dot>Draft waiting to be published</Badge> : <Badge tone="success" dot>Published</Badge>;

  return (
    <div className="grid gap-5" data-testid="mobile-app-manager">
      <section aria-label="Configuration status" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Status" value={statusBadge} hint={overview.published.publishedAt ? `Version ${overview.published.version} by ${overview.published.publishedBy ?? 'someone'}` : 'Nothing published yet'} />
        <StatCard label="Modules" value={overview.stats.totalModules} hint="Available to configure" />
        <StatCard label="Shown on phones" value={overview.stats.enabledModules} hint="In the published version" testId="stat-enabled" />
        <StatCard label="Hidden" value={overview.stats.disabledModules} hint="Data kept; web unchanged" testId="stat-hidden" />
        <StatCard label="Version" value={`v${overview.published.version}`} hint={overview.published.publishedAt ? `Published ${when(overview.published.publishedAt)}` : 'Starting configuration'} testId="stat-version" />
      </section>

      <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface/95 px-3 py-2 backdrop-blur">
        <div role="tablist" aria-label="Mobile app sections" className="flex flex-wrap gap-1">
          {([['modules', 'Modules and features'], ['home', 'Home and quick actions'], ['history', 'History']] as const).map(([k, label]) => (
            <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)} className={cn('rounded-lg px-3 py-1.5 text-[0.8125rem] font-medium', tab === k ? 'bg-accent text-accent-fg' : 'text-fg-muted hover:bg-bg-subtle')}>
              {label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {(unsaved || changes.length > 0) && <span className="text-xs text-fg-muted" data-testid="change-count">{changes.length} change{changes.length === 1 ? '' : 's'} from the published version{unsaved ? ' (not saved yet)' : ''}</span>}
          {overview.draft.updatedAt && overview.stats.status === 'draft_pending' && <Button size="sm" variant="ghost" onClick={discard} disabled={pending}>Discard draft</Button>}
          <Button size="sm" variant="secondary" onClick={save} loading={pending && !publishing} disabled={!unsaved}>Save draft</Button>
          <Button size="sm" onClick={() => setPublishing(true)} disabled={!changes.length || pending}>Review and publish</Button>
        </div>
      </div>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {issues.length > 0 && (
        <Alert tone={errors.length ? 'danger' : 'warning'} title={errors.length ? 'Fix these before publishing' : 'Worth a look'}>
          <ul className="list-disc pl-5" data-testid="config-issues">{issues.map((i, n) => <li key={n}>{i.message}</li>)}</ul>
        </Alert>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0">
          {tab === 'modules' && (
            <div className="grid gap-3">
              {sorted.map((m, idx) => (
                <ModuleCard
                  key={m.key}
                  def={m}
                  config={config}
                  update={update}
                  available={available.has(m.key)}
                  used={overview.usage[m.key] ?? 0}
                  first={idx === 0}
                  last={idx === sorted.length - 1}
                  move={(d) => move(m.key, d)}
                />
              ))}
            </div>
          )}
          {tab === 'home' && <HomeSettings config={config} update={update} />}
          {tab === 'history' && <HistoryList versions={versions} current={overview.published.version} onRestore={setRestoring} />}
        </div>
        <aside className="xl:sticky xl:top-16 xl:self-start" aria-label="Phone preview">
          <Card>
            <CardHeader title="Preview" description="Read-only. Shows the company’s modules for a level; each person’s own permissions can hide more." />
            <CardBody className="grid gap-3">
              <div role="radiogroup" aria-label="Preview as" className="grid grid-cols-3 gap-1 rounded-lg bg-bg-subtle p-1">
                {MOBILE_LEVELS.map((l) => (
                  <button key={l} type="button" role="radio" aria-checked={level === l} onClick={() => setLevel(l)} className={cn('rounded-md px-2 py-1 text-xs font-medium', level === l ? 'bg-surface text-fg shadow-sm' : 'text-fg-muted')}>
                    {LEVEL_SHORT[l]}
                  </button>
                ))}
              </div>
              <PhonePreview app={preview} />
            </CardBody>
          </Card>
        </aside>
      </div>

      {publishing && (
        <PublishDialog
          overview={overview}
          config={config}
          unsaved={unsaved}
          changes={changes}
          errors={errors.map((e) => e.message)}
          onClose={() => setPublishing(false)}
          onDone={async (o, text) => {
            refresh(o);
            setPublishing(false);
            setMsg({ tone: 'success', text });
            await reloadVersions();
          }}
        />
      )}
      {restoring && (
        <Dialog
          open
          onClose={() => setRestoring(null)}
          title={`Restore version ${restoring.version}?`}
          description="It is published again as a new version, so phones follow it within a minute. The history keeps every version."
          footer={
            <>
              <Button variant="secondary" onClick={() => setRestoring(null)}>Cancel</Button>
              <Button
                loading={pending}
                onClick={() => start(async () => {
                  const r = await restoreMobileVersionAction(restoring.version);
                  setRestoring(null);
                  if (!r.ok) return setMsg({ tone: 'danger', text: r.message });
                  refresh(r.data!);
                  setMsg({ tone: 'success', text: `Version ${restoring.version} restored as version ${r.data!.published.version}.` });
                  await reloadVersions();
                })}
              >
                Restore and publish
              </Button>
            </>
          }
        >
          <ChangeList items={restoring.changes} empty="This version made no changes to the one before it." />
        </Dialog>
      )}
    </div>
  );
}

function StatCard({ label, value, hint, testId }: { label: string; value: React.ReactNode; hint?: string; testId?: string }) {
  return (
    <Card className="p-4" data-testid={testId}>
      <div className="text-xs font-medium text-fg-muted">{label}</div>
      <div className="mt-1.5 text-xl font-semibold tracking-tight tabular">{value}</div>
      {hint && <div className="mt-1 text-xs text-fg-subtle">{hint}</div>}
    </Card>
  );
}

function LevelChecks({ levels, onChange, label, disabled }: { levels: Record<MobileLevel, boolean>; onChange: (l: MobileLevel, v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <fieldset className="flex flex-wrap gap-1" aria-label={`${label}: levels`} disabled={disabled}>
      {MOBILE_LEVELS.map((l) => (
        <label key={l} className={cn('inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors', levels[l] ? 'border-accent/40 bg-accent/10 text-fg' : 'border-border text-fg-subtle', disabled && 'cursor-not-allowed opacity-50')}>
          <input type="checkbox" className="size-3 accent-[var(--color-accent)]" checked={levels[l]} onChange={(e) => onChange(l, e.target.checked)} aria-label={`${label} for ${MOBILE_LEVEL_LABEL[l]}`} />
          {LEVEL_SHORT[l]}
        </label>
      ))}
    </fieldset>
  );
}

function ModuleCard({ def, config, update, available, used, first, last, move }: {
  def: MobileModuleDef; config: MobileAppConfig; update: (fn: (c: MobileAppConfig) => void) => void; available: boolean; used: number; first: boolean; last: boolean; move: (dir: -1 | 1) => void;
}) {
  const c = config.modules[def.key]!;
  const [open, setOpen] = useState(false);
  const onCount = def.features.filter((f) => c.features[f.key]?.enabled).length;
  return (
    <Card className={cn('overflow-hidden transition-opacity', !c.enabled && 'opacity-75')} data-testid={`module-${def.key}`}>
      <div className="flex flex-wrap items-start gap-3 p-4">
        <span className={cn('mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl text-white shadow-sm', c.enabled ? 'bg-gradient-to-br from-accent to-[var(--color-accent-2,var(--color-accent))]' : 'bg-fg-subtle')} aria-hidden>
          <Icon name={def.icon} className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[0.9375rem] font-semibold">{def.name}</h3>
            {def.locked && <Badge tone="info">Always on</Badge>}
            {!available && <Badge tone="warning">Not in your plan</Badge>}
            {used > 0 && <Badge tone="neutral">{used} {used === 1 ? 'person' : 'people'} used it this month</Badge>}
          </div>
          <p className="mt-0.5 text-[0.8125rem] text-fg-muted">{def.description}</p>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <LevelChecks label={def.name} levels={c.levels} disabled={!c.enabled || def.locked} onChange={(l, v) => update((x) => void (x.modules[def.key]!.levels[l] = v))} />
            {def.key !== 'home' && (
              <label className="flex items-center gap-2 text-xs text-fg-muted">
                Menu
                <Select aria-label={`${def.name}: where it sits`} className="h-8 w-auto py-0 text-xs" value={c.placement} disabled={!c.enabled} onChange={(e) => update((x) => void (x.modules[def.key]!.placement = e.target.value as 'tab' | 'more'))}>
                  <option value="tab" disabled={!def.tabbable}>Bottom bar{def.tabbable ? '' : ' (not available)'}</option>
                  <option value="more">More menu</option>
                </Select>
              </label>
            )}
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" aria-label={`Move ${def.name} up`} disabled={first} onClick={() => move(-1)}><ArrowUp className="size-3.5" /></Button>
              <Button size="sm" variant="ghost" aria-label={`Move ${def.name} down`} disabled={last} onClick={() => move(1)}><ArrowDown className="size-3.5" /></Button>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <span className="text-xs text-fg-muted" aria-hidden>{c.enabled ? 'Shown' : 'Hidden'}</span>
          <Switch label={`Show ${def.name} in the mobile app`} checked={c.enabled} disabled={def.locked} onChange={(v) => update((x) => void (x.modules[def.key]!.enabled = v))} testId={`switch-${def.key}`} />
        </div>
      </div>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center justify-between border-t border-border bg-bg-subtle/50 px-4 py-2 text-left text-xs font-medium text-fg-muted hover:bg-bg-subtle">
        <span>Features: {onCount} of {def.features.length} on</span>
        <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <ul className="divide-y divide-border" aria-label={`${def.name} features`}>
          {def.features.map((f) => {
            const fc = c.features[f.key]!;
            return (
              <li key={f.key} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid={`feature-${def.key}-${f.key}`}>
                <div className="min-w-0 flex-1">
                  <div className="text-[0.8125rem] font-medium">{f.name}</div>
                  <div className="text-xs text-fg-muted">{f.description}{f.requires ? ` Needs ${def.features.find((x) => x.key === f.requires)?.name}.` : ''}</div>
                </div>
                <LevelChecks label={`${def.name}: ${f.name}`} levels={fc.levels} disabled={!c.enabled || !fc.enabled} onChange={(l, v) => update((x) => void (x.modules[def.key]!.features[f.key]!.levels[l] = v))} />
                <Switch label={`${def.name}: ${f.name}`} checked={fc.enabled} disabled={!c.enabled} onChange={(v) => update((x) => void (x.modules[def.key]!.features[f.key]!.enabled = v))} testId={`switch-${def.key}-${f.key}`} />
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function ShortcutList({ kind, config, update }: { kind: 'quickActions' | 'widgets'; config: MobileAppConfig; update: (fn: (c: MobileAppConfig) => void) => void }) {
  const defs = kind === 'quickActions' ? MOBILE_QUICK_ACTIONS : MOBILE_WIDGETS;
  const list = config[kind];
  const move = (i: number, d: -1 | 1) => update((c) => {
    const l = c[kind];
    const j = i + d;
    if (j < 0 || j >= l.length) return;
    [l[i], l[j]] = [l[j]!, l[i]!];
  });
  return (
    <ul className="divide-y divide-border" data-testid={`list-${kind}`}>
      {list.map((s, i) => {
        const d = defs.find((x) => x.key === s.key)!;
        const moduleOn = MOBILE_LEVELS.some((l) => mobileKeyOn(config, d.feature, l));
        return (
          <li key={s.key} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent" aria-hidden><Icon name={d.icon} /></span>
            <div className="min-w-0 flex-1">
              <div className="text-[0.8125rem] font-medium">{d.name}</div>
              {!moduleOn && <div className="text-xs text-warning">Its module or feature is hidden, so it will not show.</div>}
            </div>
            <LevelChecks label={d.name} levels={s.levels} disabled={!s.enabled} onChange={(l, v) => update((c) => void (c[kind][i]!.levels[l] = v))} />
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" aria-label={`Move ${d.name} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-3.5" /></Button>
              <Button size="sm" variant="ghost" aria-label={`Move ${d.name} down`} disabled={i === list.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-3.5" /></Button>
            </div>
            <Switch label={`${kind === 'quickActions' ? 'Quick action' : 'Home widget'}: ${d.name}`} checked={s.enabled} onChange={(v) => update((c) => void (c[kind][i]!.enabled = v))} />
          </li>
        );
      })}
    </ul>
  );
}

function HomeSettings({ config, update }: { config: MobileAppConfig; update: (fn: (c: MobileAppConfig) => void) => void }) {
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader title="Welcome line" description="A short line under the greeting on everyone’s home screen. Leave it empty for none." />
        <CardBody>
          <Input aria-label="Welcome line" maxLength={120} value={config.welcome} placeholder="For example: Have a great day at work" onChange={(e) => update((c) => void (c.welcome = e.target.value))} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Quick actions" description="Big buttons at the top of the home screen, in this order. Up to 8 show; each only when its module and the person’s access allow it." />
        <CardBody className="p-0"><ShortcutList kind="quickActions" config={config} update={update} /></CardBody>
      </Card>
      <Card>
        <CardHeader title="Home widgets" description="Cards on the home screen, in this order. Company-wide cards need the person’s permission to see others’ data." />
        <CardBody className="p-0"><ShortcutList kind="widgets" config={config} update={update} /></CardBody>
      </Card>
    </div>
  );
}

function ChangeList({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) return <p className="text-[0.8125rem] text-fg-muted">{empty}</p>;
  return <ul className="grid gap-1 text-[0.8125rem]">{items.map((c, i) => <li key={i} className="flex gap-2"><span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />{c}</li>)}</ul>;
}

function HistoryList({ versions, current, onRestore }: { versions: MobileAppVersion[]; current: number; onRestore: (v: MobileAppVersion) => void }) {
  return (
    <Card>
      <CardHeader title="Published versions" description="Every version, who published it and what changed. Restoring publishes an old version again as a new one." />
      <CardBody className="p-0">
        {!versions.length ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-[0.8125rem] text-fg-muted"><History className="size-6" aria-hidden />Nothing published yet. Phones use the starting configuration.</div>
        ) : (
          <ol className="divide-y divide-border" data-testid="versions">
            {versions.map((v) => (
              <li key={v.version} className="grid gap-2 px-4 py-3 sm:grid-cols-[6rem_1fr_auto]">
                <div>
                  <div className="font-semibold tabular">v{v.version}</div>
                  {v.version === current && <Badge tone="success">Live</Badge>}
                </div>
                <div className="min-w-0">
                  <div className="text-xs text-fg-muted">{when(v.publishedAt)} by {v.publishedBy ?? 'someone'}{v.restoredFrom ? ` · restored from v${v.restoredFrom}` : ''}</div>
                  {v.note && <div className="mt-0.5 text-[0.8125rem]">{v.note}</div>}
                  <div className="mt-1.5"><ChangeList items={v.changes} empty="No changes listed." /></div>
                </div>
                <div>{v.version !== current && <Button size="sm" variant="secondary" onClick={() => onRestore(v)} data-testid={`restore-${v.version}`}>Restore</Button>}</div>
              </li>
            ))}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}

function PublishDialog({ overview, config, unsaved, changes, errors, onClose, onDone }: {
  overview: MobileAppOverview; config: MobileAppConfig; unsaved: boolean; changes: string[]; errors: string[]; onClose: () => void; onDone: (o: MobileAppOverview, text: string) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // Modules this hides from a level while people used them on phones lately.
  const hiding = MODULES.filter((m) => (overview.usage[m.key] ?? 0) > 0 && MOBILE_LEVELS.some((l) => mobileKeyOn(overview.published.config, m.key, l) && !mobileKeyOn(config, m.key, l)));
  const go = () => start(async () => {
    setError(null);
    let revision = overview.draft.revision;
    if (unsaved) {
      const saved = await saveMobileDraftAction(config);
      if (!saved.ok) return setError(saved.message);
      revision = saved.data!.draft.revision;
    }
    const r = await publishMobileAction({ draftRevision: revision, note, confirmHidingInUse: confirm });
    if (!r.ok) return setError(r.message);
    await onDone(r.data!, `Version ${r.data!.published.version} published. Phones pick it up within a minute, or at once when the app is opened.`);
  });
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Publish to every phone"
      description="People do not need to update or reinstall the app. Hidden modules keep all their data, and the Web Portal does not change."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={go} loading={pending} disabled={errors.length > 0 || (hiding.length > 0 && !confirm)} data-testid="confirm-publish">Publish version {overview.published.version + 1}</Button>
        </>
      }
    >
      <div className="grid gap-4">
        <section aria-label="Changes">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-fg-muted">What changes</h3>
          <ChangeList items={changes} empty="No changes." />
        </section>
        {errors.length > 0 && <Alert tone="danger" title="Fix these first"><ul className="list-disc pl-5">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul></Alert>}
        {hiding.length > 0 && (
          <Alert tone="warning" title="People use these on their phones">
            <p>{hiding.map((m) => `${m.name} (${overview.usage[m.key]} ${overview.usage[m.key] === 1 ? 'person' : 'people'} in the last 30 days)`).join(', ')}. They will no longer see it on the phone; their records stay.</p>
            <label className="mt-2 flex items-center gap-2 font-medium">
              <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> Hide it anyway
            </label>
          </Alert>
        )}
        <label className="grid gap-1 text-[0.8125rem]">
          <span className="font-medium">Note for the history (optional)</span>
          <Textarea rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this change" />
        </label>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}

/** A phone-shaped, read-only picture of the app for the chosen level. */
function PhonePreview({ app }: { app: ReturnType<typeof resolveMobileApp> }) {
  const byKey = new Map(app.modules.map((m) => [m.key, m]));
  const tabs = ['home', ...app.tabs].map((k) => byKey.get(k)).filter(Boolean);
  return (
    <div className="mx-auto w-full max-w-[17rem]" data-testid="phone-preview">
      <div className="overflow-hidden rounded-[2rem] border-[6px] border-[#16122e] bg-[#f5f3ff] shadow-xl dark:bg-[#0f0b24]">
        <div className="bg-gradient-to-br from-[#5b3df5] via-[#7c4dff] to-[#c04df5] px-4 pb-4 pt-5 text-white">
          <div className="flex items-center justify-between text-[0.625rem] opacity-80"><span>9:41</span><Smartphone className="size-3" aria-hidden /></div>
          <div className="mt-3 flex items-center justify-between">
            <div>
              <div className="text-xs opacity-80">Good morning,</div>
              <div className="text-sm font-semibold">Your name</div>
              <div className="text-[0.625rem] opacity-80">{app.levelLabel}</div>
            </div>
            <span className="relative flex size-8 items-center justify-center rounded-full bg-white/20"><Bell className="size-4" aria-hidden />{byKey.has('notifications') && <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-[#ff5c8a]" />}</span>
          </div>
          {app.welcome && <div className="mt-2 text-[0.6875rem] opacity-90">{app.welcome}</div>}
          {byKey.get('home')?.features.includes('search') && <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-white/15 px-2 py-1.5 text-[0.625rem] opacity-90"><Search className="size-3" aria-hidden />Search</div>}
        </div>
        <div className="grid gap-2 p-3">
          {app.quickActions.length > 0 && (
            <div className="grid grid-cols-4 gap-1.5" aria-label="Quick actions">
              {app.quickActions.map((q) => (
                <div key={q.key} className="flex flex-col items-center gap-1 text-center">
                  <span className="flex size-9 items-center justify-center rounded-xl bg-white text-[#5b3df5] shadow-sm dark:bg-white/10 dark:text-white"><Icon name={q.icon} /></span>
                  <span className="line-clamp-2 text-[0.5625rem] leading-tight text-fg-muted">{q.name}</span>
                </div>
              ))}
            </div>
          )}
          <div className="grid gap-1.5" aria-label="Home widgets">
            {app.widgets.slice(0, 5).map((w) => (
              <div key={w.key} className="flex items-center gap-2 rounded-xl bg-white px-2.5 py-2 text-[0.6875rem] shadow-sm dark:bg-white/5">
                <Icon name={w.icon} className="size-3.5 text-[#7c4dff]" /> <span className="truncate">{w.name}</span>
              </div>
            ))}
            {app.widgets.length > 5 && <div className="text-center text-[0.625rem] text-fg-subtle">+{app.widgets.length - 5} more cards</div>}
          </div>
        </div>
        <nav aria-label="Bottom bar" className="flex items-stretch justify-around border-t border-white/10 bg-[#16122e] px-1 py-1.5 text-white" data-testid="preview-tabs">
          {tabs.map((m) => (
            <span key={m!.key} className="flex min-w-0 flex-1 flex-col items-center gap-0.5 text-[0.5625rem]"><Icon name={m!.icon} className="size-4" /><span className="w-full truncate text-center">{m!.key === 'home' ? 'Home' : m!.name}</span></span>
          ))}
          <span className="flex min-w-0 flex-1 flex-col items-center gap-0.5 text-[0.5625rem]"><MoreHorizontal className="size-4" aria-hidden /><span>More</span></span>
        </nav>
      </div>
      <div className="mt-3">
        <div className="mb-1 text-xs font-medium text-fg-muted">In More ({app.more.length})</div>
        <div className="flex flex-wrap gap-1" data-testid="preview-more">
          {app.more.map((k) => <Badge key={k} tone="neutral">{byKey.get(k)?.name}</Badge>)}
        </div>
        <p className="mt-2 text-[0.6875rem] text-fg-subtle">The bottom bar holds Home, up to {MOBILE_MAX_TABS} modules and More.</p>
      </div>
    </div>
  );
}
