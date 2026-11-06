'use client';
import type { PlatformIntegrationDef, PlatformIntegrationKey, PlatformIntegrationView } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, Checkbox, Field, Input, Select, Switch, Textarea, cn } from '@crew/ui';
import { BellRing, Bot, ChevronDown, ExternalLink, Mail, ShieldCheck, Smartphone, type LucideIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { resetIntegrationAction, saveIntegrationAction, testIntegrationAction } from '../actions';

type Values = Record<string, unknown>;
type Flash = { tone: 'success' | 'danger' | 'warning'; text: string } | null;

const ICON: Record<PlatformIntegrationKey, LucideIcon> = { ai: Bot, email: Mail, push: BellRing, scanning: ShieldCheck, mobile_sso: Smartphone };
const SOURCE: Record<PlatformIntegrationView['source'], { label: string; tone: 'accent' | 'neutral' | 'warning' }> = {
  console: { label: 'Set in Console', tone: 'accent' },
  environment: { label: 'From server settings', tone: 'warning' },
  none: { label: 'Not set up', tone: 'neutral' },
};
const SECRET_LABEL: Record<string, string> = { apiKey: 'API key', password: 'Password', accessToken: 'Access token' };
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

export function IntegrationsView({ defs, list, canManage }: { defs: readonly PlatformIntegrationDef[]; list: PlatformIntegrationView[]; canManage: boolean }) {
  const on = list.filter((v) => v.enabled).length;
  const fromEnv = list.filter((v) => v.source === 'environment');
  return (
    <div className="grid gap-5">
      {!canManage && <Alert tone="info">You can see these settings but not change them. Only Super admins can connect, test or switch integrations.</Alert>}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] text-fg-muted">
        <span data-testid="integrations-on"><strong className="text-fg">{on}</strong> of {list.length} switched on</span>
        <span>Workspace integrations (Slack, webhooks, API keys, single sign-on) are set up by each customer in their own Settings &gt; Integrations.</span>
      </div>
      {fromEnv.length > 0 && (
        <Alert tone="info" title={`${fromEnv.length} still come${fromEnv.length === 1 ? 's' : ''} from the server's settings file`}>
          {fromEnv.map((v) => defs.find((d) => d.key === v.key)!.name).join(', ')}. Open {fromEnv.length === 1 ? 'it' : 'each one'}, check the values and press Save to manage {fromEnv.length === 1 ? 'it' : 'them'} here from now on. Saved keys and passwords are kept, so you do not need to paste them again.
        </Alert>
      )}
      {defs.map((d) => <IntegrationCard key={d.key} def={d} view={list.find((v) => v.key === d.key)!} canManage={canManage} />)}
    </div>
  );
}

function initialValues(v: PlatformIntegrationView): Values {
  const s = v.settings;
  switch (v.key) {
    case 'ai': return { enabled: v.enabled, apiKey: '', model: s.model ?? 'claude-opus-5-5', effort: s.effort ?? 'low', refusalFallback: s.refusalFallback ?? true, timeoutSeconds: s.timeoutSeconds ?? 30, baseUrl: s.baseUrl ?? '' };
    case 'email': return { enabled: v.enabled, host: s.host ?? '', port: s.port ?? 587, security: s.security ?? 'starttls', username: s.username ?? '', password: '', from: s.from ?? '' };
    case 'push': return { enabled: v.enabled, accessToken: '' };
    case 'scanning': return { enabled: v.enabled, url: s.url ?? 'tcp://clamav:3310' };
    case 'mobile_sso': return { enabled: v.enabled, redirects: ((s.redirects as string[]) ?? ['crew://sso']).join('\n') };
  }
}

/** What the API expects: numbers as numbers, the address list as an array, removed secrets as null. */
function payload(key: PlatformIntegrationKey, v: Values, remove: Set<string>): Values {
  const out: Values = { ...v };
  if (key === 'ai') out.timeoutSeconds = Number(v.timeoutSeconds);
  if (key === 'email') out.port = Number(v.port);
  if (key === 'mobile_sso') out.redirects = String(v.redirects).split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  for (const k of remove) out[k] = null;
  return out;
}

function IntegrationCard({ def, view, canManage }: { def: PlatformIntegrationDef; view: PlatformIntegrationView; canManage: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Values>(() => initialValues(view));
  const [remove, setRemove] = useState<Set<string>>(new Set());
  const [extras, setExtras] = useState<{ sendTo: string; pushToken: string }>({ sendTo: '', pushToken: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<Flash>(null);
  const [test, setTest] = useState<{ ok: boolean; detail: string } | null>(null);
  const [pending, start] = useTransition();
  const Icon = ICON[def.key];
  const set = (k: string, v: unknown) => setValues((p) => ({ ...p, [k]: v }));
  const source = SOURCE[view.source];
  const id = `integration-${def.key}`;

  const save = () => start(async () => {
    setFlash(null);
    const r = await saveIntegrationAction(def.key, payload(def.key, values, remove));
    setErrors(r.ok ? {} : r.fieldErrors ?? {});
    setFlash(r.ok ? { tone: 'success', text: r.message ?? 'Saved.' } : { tone: 'danger', text: r.message });
    if (r.ok) {
      setValues((p) => ({ ...p, ...Object.fromEntries(Object.keys(view.secrets).map((k) => [k, ''])) }));
      setRemove(new Set());
      router.refresh();
    }
  });
  const runTest = () => start(async () => {
    setFlash(null);
    setTest(null);
    const r = await testIntegrationAction(def.key, payload(def.key, values, remove), {
      ...(def.key === 'email' && extras.sendTo ? { sendTo: extras.sendTo.trim() } : {}),
      ...(def.key === 'push' && extras.pushToken ? { pushToken: extras.pushToken.trim() } : {}),
    });
    setErrors(r.ok ? {} : r.fieldErrors ?? {});
    if (r.ok && r.data) {
      setTest({ ok: r.data.ok, detail: r.data.detail });
      if (r.data.recorded) router.refresh();
    } else if (!r.ok) setFlash({ tone: 'danger', text: r.message });
  });
  const reset = () => start(async () => {
    if (!confirm(`Remove the Console setting for ${def.name}? ${view.environmentAvailable ? 'The server\'s own settings file will apply again.' : 'It will be switched off.'}`)) return;
    const r = await resetIntegrationAction(def.key);
    setFlash(r.ok ? { tone: 'success', text: r.message ?? 'Removed.' } : { tone: 'danger', text: r.message });
    if (r.ok) router.refresh();
  });

  const secret = (k: string, label: string, hint: string) => {
    const s = view.secrets[k]!;
    return (
      <Field label={label} error={errors[k]} hint={s.set ? `${hint} A ${label.toLowerCase()} is saved (${s.hint}); leave this empty to keep it.` : hint}>
        {(p) => (
          <div className="grid gap-1.5">
            <Input {...p} type="password" autoComplete="new-password" value={String(values[k] ?? '')} disabled={!canManage || remove.has(k)} placeholder={s.set ? `Saved ${s.hint}` : ''} onChange={(e) => set(k, e.target.value)} data-testid={`${def.key}-${k}`} />
            {s.set && canManage && (
              <Checkbox label={`Remove the saved ${label.toLowerCase()}`} checked={remove.has(k)} onChange={(e) => setRemove((p) => { const n = new Set(p); if (e.target.checked) n.add(k); else n.delete(k); return n; })} />
            )}
          </div>
        )}
      </Field>
    );
  };
  const text = (k: string, label: string, opts: { hint?: string; type?: string; placeholder?: string; list?: string; required?: boolean } = {}) => (
    <Field label={label} error={errors[k]} hint={opts.hint} required={opts.required}>
      {(p) => <Input {...p} type={opts.type ?? 'text'} list={opts.list} placeholder={opts.placeholder} value={String(values[k] ?? '')} disabled={!canManage} onChange={(e) => set(k, e.target.value)} data-testid={`${def.key}-${k}`} />}
    </Field>
  );

  return (
    <Card data-testid={id}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={`${id}-body`} className="flex w-full items-start gap-3 px-5 py-4 text-left">
        <span className="mt-0.5 rounded-md bg-accent-subtle p-2 text-accent"><Icon className="size-4" aria-hidden /></span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[0.9375rem] font-semibold text-fg">{def.name}</span>
            <Badge tone={view.enabled ? 'success' : 'neutral'} dot>{view.enabled ? 'On' : 'Off'}</Badge>
            <Badge tone={source.tone}>{source.label}</Badge>
            {view.lastTest && (
              <Badge tone={!view.lastTest.current ? 'neutral' : view.lastTest.ok ? 'success' : 'danger'}>
                {!view.lastTest.current ? 'Changed since last test' : view.lastTest.ok ? 'Last test passed' : 'Last test failed'}
              </Badge>
            )}
          </span>
          <span className="mt-1 block text-[0.8125rem] text-fg-muted">{def.description}</span>
          {!view.enabled && <span className="mt-1 block text-xs text-fg-subtle">While off: {def.whenOff}</span>}
        </span>
        <ChevronDown className={cn('mt-1 size-4 shrink-0 text-fg-muted transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <CardBody id={`${id}-body`} className="grid gap-6 border-t border-border pt-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <section aria-label="How to set it up">
            <h3 className="mb-3 text-[0.8125rem] font-semibold text-fg">How to set it up</h3>
            <ol className="grid gap-4">
              {def.steps.map((s, i) => (
                <li key={s.title} className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-xs font-semibold text-accent">{i + 1}</span>
                  <div className="text-[0.8125rem]">
                    <p className="font-medium text-fg">{s.title}</p>
                    <p className="mt-0.5 text-fg-muted">{s.body}</p>
                    {s.link && <a href={s.link.href} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 font-medium text-accent hover:underline">{s.link.label}<ExternalLink className="size-3" aria-hidden /></a>}
                  </div>
                </li>
              ))}
            </ol>
            {view.source === 'environment' && (
              <p className="mt-4 rounded-md bg-bg-subtle p-3 text-xs text-fg-muted">
                Currently read from the server&apos;s settings file ({def.envFallback.join(', ')}). Saving here takes over; those values are then ignored.
              </p>
            )}
            {view.updatedAt && <p className="mt-4 text-xs text-fg-subtle">Last saved {new Date(view.updatedAt).toLocaleString()}{view.updatedBy ? ` by ${view.updatedBy}` : ''}.</p>}
            {view.lastTest && (
              <p className="mt-1 text-xs text-fg-subtle">Last test of the saved settings, {new Date(view.lastTest.at).toLocaleString()}: {view.lastTest.detail}</p>
            )}
          </section>

          <form className="grid content-start gap-4" onSubmit={(e) => { e.preventDefault(); save(); }} aria-label={`${def.name} settings`}>
            {flash && <Alert tone={flash.tone}>{flash.text}</Alert>}
            <div className="flex items-start gap-3">
              <Switch checked={Boolean(values.enabled)} onChange={(v) => set('enabled', v)} disabled={!canManage} label={`Use ${def.name}`} testId={`${def.key}-enabled`} />
              <div className="text-[0.8125rem]">
                <p className="font-medium text-fg">Use {def.name}</p>
                <p className="text-xs text-fg-muted">{values.enabled ? 'On for every workspace once saved.' : 'Off once saved. You can still fill in and test the settings first.'}</p>
              </div>
            </div>

            {def.key === 'ai' && (
              <>
                {secret('apiKey', 'API key', 'Starts with sk-ant-.')}
                <div className="grid gap-4 sm:grid-cols-2">
                  {text('model', 'Model', { list: 'crew-models', hint: 'claude-opus-5-5 is the default.' })}
                  <datalist id="crew-models">{MODELS.map((m) => <option key={m} value={m} />)}</datalist>
                  <Field label="Effort" hint="How much the model thinks before answering.">
                    {(p) => (
                      <Select {...p} value={String(values.effort)} disabled={!canManage} onChange={(e) => set('effort', e.target.value)}>
                        <option value="low">Low (fast, cheapest)</option><option value="medium">Medium</option><option value="high">High</option>
                      </Select>
                    )}
                  </Field>
                  {text('timeoutSeconds', 'Time limit per answer (seconds)', { type: 'number' })}
                  {text('baseUrl', 'API address (optional)', { placeholder: 'https://api.anthropic.com', hint: 'Only for a regional gateway or proxy.' })}
                </div>
                <Checkbox label="Retry declined requests on Claude's fallback model" description="If the model declines a request, the Claude API tries once more on its fallback model." checked={Boolean(values.refusalFallback)} disabled={!canManage} onChange={(e) => set('refusalFallback', e.target.checked)} />
              </>
            )}

            {def.key === 'email' && (
              <>
                <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                  {text('host', 'SMTP server', { placeholder: 'smtp.sendgrid.net', required: true })}
                  {text('port', 'Port', { type: 'number', required: true })}
                </div>
                <Field label="Encryption" error={errors.security}>
                  {(p) => (
                    <Select {...p} value={String(values.security)} disabled={!canManage} onChange={(e) => { set('security', e.target.value); if (e.target.value === 'tls') set('port', 465); if (e.target.value === 'starttls') set('port', 587); }} data-testid="email-security">
                      <option value="starttls">STARTTLS (usually port 587)</option>
                      <option value="tls">TLS from the start (usually port 465)</option>
                      <option value="none">None (local test servers only)</option>
                    </Select>
                  )}
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  {text('username', 'User name', { hint: 'Leave empty if the server needs no sign-in.' })}
                  {secret('password', 'Password', 'Or the API key your provider gives for SMTP.')}
                </div>
                {text('from', 'Send as', { placeholder: 'SampCrew <no-reply@yourcompany.com>', required: true, hint: 'The From line people see. Use an address on your verified domain.' })}
                <Field label="Send a test email to" hint="Optional. Test connection then sends a real message here.">
                  {(p) => <Input {...p} type="email" value={extras.sendTo} disabled={!canManage} onChange={(e) => setExtras({ ...extras, sendTo: e.target.value })} data-testid="email-sendTo" />}
                </Field>
              </>
            )}

            {def.key === 'push' && (
              <>
                {secret('accessToken', 'Access token', 'Only needed when enhanced push security is on for the Expo project.')}
                <Field label="Send a test alert to device (optional)" hint="A device's Expo push token, like ExponentPushToken[xxxxxxxx].">
                  {(p) => <Input {...p} value={extras.pushToken} disabled={!canManage} onChange={(e) => setExtras({ ...extras, pushToken: e.target.value })} data-testid="push-pushToken" />}
                </Field>
              </>
            )}

            {def.key === 'scanning' && text('url', 'Scanner address', { placeholder: 'tcp://clamav:3310', required: true })}

            {def.key === 'mobile_sso' && (
              <Field label="App addresses" error={errors.redirects} hint="One per line. crew://sso is the SampCrew app.">
                {(p) => <Textarea {...p} rows={3} value={String(values.redirects)} disabled={!canManage} onChange={(e) => set('redirects', e.target.value)} data-testid="mobile_sso-redirects" />}
              </Field>
            )}

            {test && (
              <Alert tone={test.ok ? 'success' : 'danger'} title={test.ok ? 'Connection works' : 'Connection failed'}>
                <span data-testid={`${def.key}-test-result`}>{test.detail}</span>
              </Alert>
            )}
            {canManage && (
              <div className="flex flex-wrap items-center gap-2">
                {def.key !== 'mobile_sso' && <Button type="button" variant="secondary" loading={pending} onClick={runTest}>Test connection</Button>}
                <Button type="submit" loading={pending}>Save</Button>
                {view.source === 'console' && <Button type="button" variant="ghost" disabled={pending} onClick={reset}>{view.environmentAvailable ? 'Use server settings instead' : 'Remove setting'}</Button>}
              </div>
            )}
          </form>
        </CardBody>
      )}
    </Card>
  );
}
