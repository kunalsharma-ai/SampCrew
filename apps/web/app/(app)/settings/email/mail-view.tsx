'use client';
import type { TenantMailView } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, Field, Input, Select, Switch, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Lock, LockOpen, Mail, Send, ShieldCheck } from 'lucide-react';
import { useState, useTransition } from 'react';
import { saveMailAction, testMailAction } from './actions';

const ROUTE: Record<TenantMailView['route'], { tone: 'success' | 'info' | 'danger'; text: string }> = {
  company: { tone: 'success', text: 'Emails go out through your own email server, from your address.' },
  sampcrew: { tone: 'info', text: 'Emails go out through SampCrew’s email server, set up by SAMPLEDGE. Connect your own below to send from your company’s address.' },
  none: { tone: 'danger', text: 'No email server is connected, so SampCrew cannot send any email for your company: invitations, verification and password reset emails do not arrive. Connect your email server below.' },
};
const STATUS: Record<TenantMailView['recent'][number]['status'], { tone: 'success' | 'warning' | 'danger' | 'neutral'; label: string }> = {
  sent: { tone: 'success', label: 'Sent' }, queued: { tone: 'warning', label: 'Waiting' }, failed: { tone: 'danger', label: 'Failed' }, skipped: { tone: 'neutral', label: 'Not sent' },
};
/** Usual settings of the common providers, filled in with one click. */
const PRESETS = [
  { key: 'office365', label: 'Microsoft 365 / Outlook', host: 'smtp.office365.com', port: 587, security: 'starttls' },
  { key: 'gmail', label: 'Google Workspace / Gmail', host: 'smtp.gmail.com', port: 587, security: 'starttls' },
  { key: 'zoho', label: 'Zoho Mail', host: 'smtp.zoho.in', port: 587, security: 'starttls' },
  { key: 'ses', label: 'Amazon SES (Mumbai)', host: 'email-smtp.ap-south-1.amazonaws.com', port: 587, security: 'starttls' },
  { key: 'sendgrid', label: 'SendGrid', host: 'smtp.sendgrid.net', port: 587, security: 'starttls' },
] as const;

export function MailSetupView({ view: initial, me }: { view: TenantMailView; me: { email: string } }) {
  const [view, setView] = useState(initial);
  const [f, setF] = useState({
    enabled: initial.enabled || !initial.host, host: initial.host ?? '', port: String(initial.port), security: initial.security, username: initial.username ?? '',
    password: '', fromName: initial.fromName, fromAddress: initial.fromAddress ?? '', replyTo: initial.replyTo,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [sendTo, setSendTo] = useState(me.email);
  const [pending, start] = useTransition();
  // Once a server with its password is saved, the panel is locked (issue #86): the fields show what is saved, the
  // password only as an encrypted mask, and nothing changes until someone presses Unlock to edit.
  const [locked, setLocked] = useState(Boolean(initial.host && initial.passwordHint));
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => { setF((x) => ({ ...x, [k]: v })); setErrors((e) => ({ ...e, [k]: '' })); };
  const save = () => start(async () => {
    setNotice(null);
    const body: Record<string, unknown> = {
      enabled: f.enabled, host: f.host.trim(), port: Number(f.port), security: f.security, username: f.username.trim(),
      fromName: f.fromName.trim(), fromAddress: f.fromAddress.trim(), replyTo: f.replyTo.trim(),
    };
    if (f.password) body.password = f.password;
    const r = await saveMailAction(body);
    if (!r.ok) { setErrors(r.fieldErrors ?? {}); setNotice({ tone: 'danger', text: r.message }); return; }
    if (r.data) setView(r.data);
    setF((x) => ({ ...x, password: '' })); setErrors({}); setNotice({ tone: 'success', text: r.message ?? 'Saved' });
    if (r.data?.host && r.data.passwordHint) setLocked(true);
  });
  const test = () => start(async () => {
    setNotice(null);
    const r = await testMailAction(sendTo.trim());
    if (!r.ok) { setNotice({ tone: 'danger', text: r.message }); return; }
    if (r.data) { setView(r.data.view); setNotice({ tone: r.data.ok ? 'success' : 'danger', text: r.data.message }); }
  });
  const route = ROUTE[view.route];
  return (
    <div className="grid gap-5">
      <Alert tone={route.tone} title="How your emails are sent now">{route.text}</Alert>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Card>
        <CardHeader
          title="Your email server"
          description="Any email service with SMTP works. Ask your IT team or email provider for the server, port, user name and password (or an app password / API key)."
          action={locked ? (
            <div className="flex items-center gap-2">
              <Badge tone="success"><Lock className="mr-1 inline size-3" aria-hidden />Locked</Badge>
              <Button size="sm" variant="secondary" onClick={() => { setNotice(null); setLocked(false); }} data-testid="mail-unlock"><LockOpen className="size-3.5" /> Unlock to edit</Button>
            </div>
          ) : <Switch label="Send through this server" checked={f.enabled} onChange={(v) => set('enabled', v)} testId="mail-enabled" />}
        />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <fieldset disabled={locked} className="contents" data-testid="mail-panel" data-locked={locked ? 'true' : 'false'}>
          <div className="flex flex-wrap items-center gap-2 text-[0.8125rem] sm:col-span-2">
            <span className="text-fg-muted">Fill in for:</span>
            {PRESETS.map((p) => <Button key={p.key} size="sm" variant="ghost" onClick={() => setF((x) => ({ ...x, host: p.host, port: String(p.port), security: p.security }))}>{p.label}</Button>)}
          </div>
          <Field label="SMTP server" required error={errors.host}>{(p) => <Input {...p} value={f.host} placeholder="smtp.office365.com" onChange={(e) => set('host', e.target.value)} data-testid="mail-host" />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Port" required error={errors.port}>{(p) => <Input {...p} inputMode="numeric" value={f.port} onChange={(e) => set('port', e.target.value.replace(/\D/g, ''))} data-testid="mail-port" />}</Field>
            <Field label="Security" error={errors.security}>{(p) => (
              <Select {...p} value={f.security} onChange={(e) => set('security', e.target.value as typeof f.security)}>
                <option value="starttls">STARTTLS (usually port 587)</option><option value="tls">TLS (usually port 465)</option><option value="none">None (testing only)</option>
              </Select>
            )}</Field>
          </div>
          <Field label="User name" error={errors.username} hint="Usually the full email address of the mailbox.">{(p) => <Input {...p} value={f.username} autoComplete="off" onChange={(e) => set('username', e.target.value)} data-testid="mail-username" />}</Field>
          <Field label="Password or API key" error={errors.password} hint={view.passwordHint ? (locked ? 'Saved and encrypted. Nobody can read it back, not even SAMPLEDGE support.' : 'Saved and encrypted. Leave empty to keep it, or type a new one to replace it.') : 'Stored encrypted. Nobody can read it back, not even SAMPLEDGE support.'}>
            {(p) => (
              <div className="relative">
                <Input {...p} type="password" value={f.password} placeholder={view.passwordHint ? '••••••••••••' : undefined} autoComplete="new-password" onChange={(e) => set('password', e.target.value)} data-testid="mail-password" className={view.passwordHint ? 'pr-28' : undefined} />
                {view.passwordHint && !f.password && (
                  <span className="pointer-events-none absolute right-2 top-1/2 inline-flex -translate-y-1/2 items-center gap-1 rounded bg-success-subtle px-1.5 py-0.5 text-[0.6875rem] font-medium text-success" data-testid="mail-password-encrypted">
                    <ShieldCheck className="size-3" aria-hidden /> Encrypted
                  </span>
                )}
              </div>
            )}
          </Field>
          <Field label="From name" error={errors.fromName} hint="What people see the email from, such as “Northwind HR”.">{(p) => <Input {...p} value={f.fromName} maxLength={100} onChange={(e) => set('fromName', e.target.value)} data-testid="mail-from-name" />}</Field>
          <Field label="From address" required error={errors.fromAddress} hint="Your provider must allow this mailbox to send.">{(p) => <Input {...p} type="email" value={f.fromAddress} placeholder="hr@yourcompany.com" onChange={(e) => set('fromAddress', e.target.value)} data-testid="mail-from-address" />}</Field>
          <Field label="Replies go to" error={errors.replyTo} hint="Optional. Leave empty to receive replies at the From address.">{(p) => <Input {...p} type="email" value={f.replyTo} onChange={(e) => set('replyTo', e.target.value)} />}</Field>
          {!locked && (
            <div className="flex items-end justify-end gap-2 sm:col-span-1">
              {view.host && view.passwordHint && <Button variant="ghost" onClick={() => { setLocked(true); setErrors({}); }}>Cancel</Button>}
              <Button onClick={save} loading={pending} data-testid="mail-save"><Mail className="size-4" /> Save email setup</Button>
            </div>
          )}
          </fieldset>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Test the connection" description="SampCrew signs in to your server with the saved settings and sends a real email. Save first." />
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Send the test email to" className="min-w-64 flex-1">{(p) => <Input {...p} type="email" value={sendTo} onChange={(e) => setSendTo(e.target.value)} data-testid="mail-test-to" />}</Field>
          <Button variant="secondary" onClick={test} loading={pending} disabled={!view.host || !sendTo.trim()} data-testid="mail-test"><Send className="size-4" /> Send test email</Button>
          {view.lastTest && (
            <p className="w-full text-xs text-fg-muted" data-testid="mail-last-test">
              Last test {new Date(view.lastTest.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}: <Badge tone={view.lastTest.ok ? 'success' : 'danger'}>{view.lastTest.ok ? 'Worked' : 'Failed'}</Badge> {view.lastTest.message}
            </p>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Latest emails" description="The last emails SampCrew tried to send for your company, so you can see whether invitations and verification emails went out." />
        {view.recent.length ? (
          <Table aria-label="Latest emails">
            <THead><tr><TH>When</TH><TH>To</TH><TH>Subject</TH><TH>Status</TH></tr></THead>
            <TBody>
              {view.recent.map((m) => (
                <TR key={m.id}>
                  <TD className="whitespace-nowrap text-xs">{new Date(m.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</TD>
                  <TD className="text-xs">{m.to}</TD>
                  <TD className="text-xs">{m.subject}</TD>
                  <TD><Badge tone={STATUS[m.status].tone}>{STATUS[m.status].label}</Badge>{m.error && m.status !== 'sent' && <div className="mt-0.5 max-w-xs text-[0.6875rem] text-fg-subtle">{m.error}</div>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState title="No emails yet" description="Invitations, password resets and notices show here once SampCrew sends them." />}
      </Card>
    </div>
  );
}
