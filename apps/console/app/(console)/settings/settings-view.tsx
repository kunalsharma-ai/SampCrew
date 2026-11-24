'use client';
import type { ConsoleSettings } from '@crew/contracts';
import { Alert, Button, Card, CardBody, CardHeader, Field, Input, Select, Switch, Textarea } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveSettingsAction } from '../console-actions';

type Section = keyof ConsoleSettings;

export function SettingsView({ settings, plans, canManage }: { settings: ConsoleSettings; plans: { key: string; name: string }[]; canManage: boolean }) {
  const [s, setS] = useState(settings);
  const set = <K extends Section>(k: K, patch: Partial<ConsoleSettings[K]>) => setS((x) => ({ ...x, [k]: { ...x[k], ...patch } }));
  const num = (v: string) => (v === '' ? 0 : Number(v));
  const ro = !canManage;
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {ro && <Alert tone="info" className="lg:col-span-2">Read only: your role cannot change global settings.</Alert>}
      <SectionCard title="New workspaces" description="Used when a company is created or signs up." section="workspaceDefaults" s={s} original={settings} ro={ro}>
        <Field label="Trial days" hint="0 to 90">{(p) => <Input {...p} type="number" min={0} max={90} value={s.workspaceDefaults.trialDays} disabled={ro} onChange={(e) => set('workspaceDefaults', { trialDays: num(e.target.value) })} />}</Field>
        <Field label="Default plan">{(p) => <Select {...p} value={s.workspaceDefaults.defaultPlan ?? ''} disabled={ro} onChange={(e) => set('workspaceDefaults', { defaultPlan: e.target.value || null })}><option value="">None</option>{plans.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}</Select>}</Field>
        <Field label="Data region">{(p) => <Select {...p} value={s.workspaceDefaults.region} disabled={ro} onChange={(e) => set('workspaceDefaults', { region: e.target.value as ConsoleSettings['workspaceDefaults']['region'] })}>{['in', 'eu', 'us', 'uk', 'me', 'sg', 'au'].map((r) => <option key={r} value={r}>{r.toUpperCase()}</option>)}</Select>}</Field>
        <Switch label="Require two-step verification for workspace admins" checked={s.workspaceDefaults.requireMfa} disabled={ro} onChange={(v) => set('workspaceDefaults', { requireMfa: v })} />
      </SectionCard>
      <SectionCard title="New users" section="userDefaults" s={s} original={settings} ro={ro}>
        <Field label="Invitation link valid for (days)" hint="1 to 30">{(p) => <Input {...p} type="number" min={1} max={30} value={s.userDefaults.inviteExpiryDays} disabled={ro} onChange={(e) => set('userDefaults', { inviteExpiryDays: num(e.target.value) })} />}</Field>
        <Field label="Super Workspace Admin gets in by">{(p) => <Select {...p} value={s.userDefaults.ownerAccess} disabled={ro} onChange={(e) => set('userDefaults', { ownerAccess: e.target.value as 'invite' | 'password' })}><option value="invite">Invitation link</option><option value="password">Temporary password</option></Select>}</Field>
      </SectionCard>
      <SectionCard title="Client communication" section="communication" s={s} original={settings} ro={ro}>
        <Field label="Support hours" hint="Added to the automatic reply">{(p) => <Input {...p} value={s.communication.supportHours} disabled={ro} maxLength={120} onChange={(e) => set('communication', { supportHours: e.target.value })} />}</Field>
        <Field label="First answer target (hours)">{(p) => <Input {...p} type="number" min={1} max={168} value={s.communication.firstResponseHours} disabled={ro} onChange={(e) => set('communication', { firstResponseHours: num(e.target.value) })} />}</Field>
        <Field label="Automatic reply to a new conversation" hint="Posted as SampCrew Support when a Super Workspace starts a conversation. Leave empty for none." className="sm:col-span-2">{(p) => <Textarea {...p} rows={2} value={s.communication.autoReply} disabled={ro} maxLength={1000} onChange={(e) => set('communication', { autoReply: e.target.value })} />}</Field>
      </SectionCard>
      <SectionCard title="Console security" section="security" s={s} original={settings} ro={ro}>
        <Field label="Session length (hours)" hint="1 to 72">{(p) => <Input {...p} type="number" min={1} max={72} value={s.security.sessionHours} disabled={ro} onChange={(e) => set('security', { sessionHours: num(e.target.value) })} />}</Field>
        <Field label="Lock after failed sign-ins">{(p) => <Input {...p} type="number" min={3} max={20} value={s.security.lockoutAttempts} disabled={ro} onChange={(e) => set('security', { lockoutAttempts: num(e.target.value) })} />}</Field>
        <Field label="Lock for (minutes)">{(p) => <Input {...p} type="number" min={1} max={1440} value={s.security.lockoutMinutes} disabled={ro} onChange={(e) => set('security', { lockoutMinutes: num(e.target.value) })} />}</Field>
        <Field label="Flag after failed sign-ins a day">{(p) => <Input {...p} type="number" min={3} max={100} value={s.security.suspiciousFailedLogins} disabled={ro} onChange={(e) => set('security', { suspiciousFailedLogins: num(e.target.value) })} />}</Field>
      </SectionCard>
      <SectionCard title="Notifications" section="notifications" s={s} original={settings} ro={ro}>
        <Field label="Renewal notice (days before)">{(p) => <Input {...p} type="number" min={1} max={60} value={s.notifications.renewalNoticeDays} disabled={ro} onChange={(e) => set('notifications', { renewalNoticeDays: num(e.target.value) })} />}</Field>
        <Field label="Company counts as inactive after (days)">{(p) => <Input {...p} type="number" min={7} max={365} value={s.notifications.inactiveAfterDays} disabled={ro} onChange={(e) => set('notifications', { inactiveAfterDays: num(e.target.value) })} />}</Field>
      </SectionCard>
      <SectionCard title="Branding" section="branding" s={s} original={settings} ro={ro}>
        <Field label="Console name">{(p) => <Input {...p} value={s.branding.consoleName} disabled={ro} maxLength={60} onChange={(e) => set('branding', { consoleName: e.target.value })} />}</Field>
        <Field label="Support email" hint="Shown in the Console menu">{(p) => <Input {...p} type="email" value={s.branding.supportEmail ?? ''} disabled={ro} onChange={(e) => set('branding', { supportEmail: e.target.value || null })} />}</Field>
        <Field label="Accent colour" hint="#RRGGBB, used for the Console highlight colour">{(p) => <Input {...p} value={s.branding.accent ?? ''} disabled={ro} maxLength={7} onChange={(e) => set('branding', { accent: e.target.value || null })} />}</Field>
      </SectionCard>
    </div>
  );
}

function SectionCard<K extends Section>({ title, description, section, s, original, ro, children }: { title: string; description?: string; section: K; s: ConsoleSettings; original: ConsoleSettings; ro: boolean; children: React.ReactNode }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const dirty = JSON.stringify(s[section]) !== JSON.stringify(original[section]);
  return (
    <Card data-testid={`settings-${section}`}>
      <CardHeader title={title} description={description} action={ro ? undefined : <Button size="sm" disabled={!dirty} loading={pending} onClick={() => start(async () => {
        const r = await saveSettingsAction({ [section]: s[section] });
        setMsg(r.ok ? { tone: 'success', text: 'Saved.' } : { tone: 'danger', text: r.message ?? 'Not saved' });
        if (r.ok) router.refresh();
      })}>Save</Button>} />
      <CardBody className="grid gap-3 sm:grid-cols-2">
        {msg && <Alert tone={msg.tone} className="sm:col-span-2">{msg.text}</Alert>}
        {children}
      </CardBody>
    </Card>
  );
}
