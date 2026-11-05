'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, EmptyState, Field, Input, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { useRunner } from '../../recruitment/use-runner';
import { SecretOnce } from '../integrations/secret-once';
import { createScimTokenAction, removeSsoAction, revokeScimTokenAction, saveSsoAction, ssoStatusAction, testSsoAction } from './actions';

export interface SsoConnection {
  id: string;
  issuer: string;
  clientId: string;
  domains: string[];
  status: 'draft' | 'active' | 'disabled';
  enforced: boolean;
  jitProvisioning: boolean;
  verifiedAt: string | null;
  verifiedEmail: string | null;
  updatedAt: string;
}
export interface SsoState {
  connection: SsoConnection | null;
  redirectUri: string;
}
export interface ScimStatus {
  baseUrl: string;
  token: { id: string; prefix: string; lastUsedAt: string | null; useCount: number; createdAt: string; createdBy: string } | null;
  provisioned: number;
  events: { method: string; path: string; status: number; detail: string | null; createdAt: string }[];
}

const STATUS: Record<SsoConnection['status'], { label: string; tone: 'neutral' | 'success' | 'warning' }> = {
  draft: { label: 'Not switched on', tone: 'neutral' },
  active: { label: 'On', tone: 'success' },
  disabled: { label: 'Switched off', tone: 'warning' },
};
const when = (d: string | null) => (d ? new Date(d).toLocaleString() : 'Never');

function CopyValue({ value, testId }: { value: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code data-testid={testId} className="break-all rounded bg-bg-subtle px-2 py-1 font-mono text-[12px] text-fg">{value}</code>
      <Button size="sm" variant="ghost" type="button" onClick={() => { void navigator.clipboard?.writeText(value).catch(() => undefined); setCopied(true); }}>
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

export function SsoView({ sso, scim, tested, failure }: { sso: SsoState; scim: ScimStatus; tested: boolean; failure: string | null }) {
  const c = sso.connection;
  const { pending, notice, run } = useRunner();
  const [editing, setEditing] = useState(!c);
  const [issuer, setIssuer] = useState(c?.issuer ?? '');
  const [clientId, setClientId] = useState(c?.clientId ?? '');
  const [secret, setSecret] = useState('');
  const [domains, setDomains] = useState(c?.domains.join(', ') ?? '');
  const [jit, setJit] = useState(c?.jitProvisioning ?? false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const domainList = domains.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
  const valid = /^https?:\/\/\S+$/.test(issuer.trim()) && clientId.trim().length > 0 && domainList.length > 0;

  const save = () =>
    run(async () => {
      const r = await saveSsoAction({ issuer: issuer.trim(), clientId: clientId.trim(), clientSecret: secret || undefined, domains: domainList, jitProvisioning: jit });
      if (r.ok) {
        setEditing(false);
        setSecret('');
        setError(null);
      } else setError(r.message);
      return r;
    });
  const test = () =>
    run(async () => {
      const r = await testSsoAction();
      if (r.ok) window.location.assign(r.data!.authorizationUrl);
      return { ...r, message: r.ok ? 'Opening your identity provider…' : r.message };
    });

  return (
    <div className="grid gap-6">
      {tested && <Alert tone="success" title="Test sign-in passed">The provider signed you in and CREW verified the ID token. You can switch single sign-on on now.</Alert>}
      {failure && <Alert tone="danger" title="Test sign-in failed">{failure}</Alert>}
      {notice && !token && <Alert tone={notice.tone}>{notice.text}</Alert>}

      <Card>
        <CardHeader
          title="Single sign-on (OpenID Connect)"
          description="SAML is not supported yet. Most providers offer OpenID Connect for new apps."
          action={c && <Badge tone={STATUS[c.status].tone} dot>{STATUS[c.status].label}{c.enforced ? ', required' : ''}</Badge>}
        />
        <CardBody className="grid gap-5">
          <div className="grid gap-1">
            <p className="text-[13px] font-medium text-fg">1. Register CREW in your identity provider</p>
            <p className="text-[13px] text-fg-muted">Create a web application with the authorization code flow and this redirect URI, then assign it to the people who should use CREW.</p>
            <CopyValue value={sso.redirectUri} testId="redirect-uri" />
          </div>

          {c && !editing ? (
            <div className="grid gap-3">
              <p className="text-[13px] font-medium text-fg">2. Connection</p>
              <dl className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-[10rem_1fr]">
                <dt className="text-fg-muted">Issuer</dt><dd className="break-all font-mono text-[12px]">{c.issuer}</dd>
                <dt className="text-fg-muted">Client ID</dt><dd className="break-all font-mono text-[12px]">{c.clientId}</dd>
                <dt className="text-fg-muted">Email domains</dt><dd>{c.domains.join(', ')}</dd>
                <dt className="text-fg-muted">New people</dt><dd>{c.jitProvisioning ? 'Get an account with the Employee role on first sign-in (within your seat limit)' : 'Must be invited or provisioned first'}</dd>
                <dt className="text-fg-muted">Last test</dt><dd data-testid="sso-verified">{c.verifiedAt ? `Passed ${when(c.verifiedAt)} as ${c.verifiedEmail}` : 'Not tested yet'}</dd>
              </dl>
              <div><Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Change settings</Button></div>
            </div>
          ) : (
            <div className="grid gap-4">
              <p className="text-[13px] font-medium text-fg">2. Connect it here</p>
              {error && <Alert tone="danger">{error}</Alert>}
              <Field label="Issuer URL" hint="From the provider, for example https://login.microsoftonline.com/<tenant>/v2.0. CREW reads its settings from /.well-known/openid-configuration." required>
                {(p) => <Input {...p} name="issuer" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://" />}
              </Field>
              <Field label="Client ID" required>
                {(p) => <Input {...p} name="clientId" value={clientId} onChange={(e) => setClientId(e.target.value)} />}
              </Field>
              <Field label="Client secret" hint={c ? 'Leave blank to keep the stored secret. It is stored encrypted and never shown again.' : 'Stored encrypted and never shown again.'}>
                {(p) => <Input {...p} name="clientSecret" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />}
              </Field>
              <Field label="Email domains" hint="Comma-separated. People with these addresses are sent to your provider. A domain can belong to one workspace only." required>
                {(p) => <Input {...p} name="domains" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="example.com" />}
              </Field>
              <Checkbox label="Create accounts on first sign-in" description="Someone your provider signs in who has no CREW account yet gets one, with the Employee role only. Off: they must be invited or provisioned with SCIM first." checked={jit} onChange={(e) => setJit(e.target.checked)} />
              {c && <Alert tone="warning">Changing the issuer or client ID switches single sign-on off until a new test sign-in passes.</Alert>}
              <div className="flex gap-2">
                <Button loading={pending} disabled={!valid} onClick={save}>Save and check provider</Button>
                {c && <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
              </div>
            </div>
          )}

          {c && !editing && (
            <div className="grid gap-3">
              <p className="text-[13px] font-medium text-fg">3. Test, then switch on</p>
              <p className="text-[13px] text-fg-muted">The test sends you to the provider and back without signing anyone in. Use an account with one of the domains above.</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" disabled={pending} onClick={test}>Test sign-in</Button>
                {c.status !== 'active' && <Button disabled={pending || !c.verifiedAt} onClick={() => run(() => ssoStatusAction('active', false))}>Switch on</Button>}
                {c.status === 'active' && !c.enforced && (
                  <Button disabled={pending} onClick={() => { if (confirm('Require single sign-on? Everyone except owners is signed out now and must sign in through your provider. Owners keep their password as a way back in.')) run(() => ssoStatusAction('active', true)); }}>Require for everyone</Button>
                )}
                {c.status === 'active' && c.enforced && <Button variant="secondary" disabled={pending} onClick={() => run(() => ssoStatusAction('active', false))}>Allow passwords again</Button>}
                {c.status === 'active' && <Button variant="ghost" disabled={pending} onClick={() => run(() => ssoStatusAction('disabled', false))}>Switch off</Button>}
                <Button variant="danger" disabled={pending} onClick={() => { if (confirm('Remove the connection? Single sign-on stops and the email domains are released.')) run(() => removeSsoAction()); }}>Remove</Button>
              </div>
              {!c.verifiedAt && <p className="text-xs text-fg-subtle">Switching on needs a passing test sign-in first.</p>}
              <p className="text-xs text-fg-subtle">The CREW mobile app does not support single sign-on yet. While it is required, members sign in on the web.</p>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="User provisioning (SCIM 2.0)"
          description="Your identity provider creates, updates and deactivates CREW accounts. Deactivating someone signs them out at once. Groups are not supported yet; roles are managed in CREW."
          action={<Badge tone={scim.token ? 'success' : 'neutral'}>{scim.provisioned} provisioned</Badge>}
        />
        <CardBody className="grid gap-4">
          {token && <SecretOnce label="SCIM token" value={token} onDone={() => setToken(null)} />}
          <div className="grid gap-1">
            <p className="text-[13px] text-fg-muted">SCIM base URL</p>
            <CopyValue value={scim.baseUrl} testId="scim-base-url" />
          </div>
          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            {scim.token ? (
              <span data-testid="scim-token">Token <span className="font-mono">crew_scim_{scim.token.prefix}_…</span> by {scim.token.createdBy} · last used {when(scim.token.lastUsedAt)} · {scim.token.useCount} calls</span>
            ) : <span className="text-fg-muted">No token. Provisioning is off.</span>}
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => { if (!scim.token || confirm('Create a new token? The current one stops working at once.')) run(() => createScimTokenAction(), (d) => setToken((d as { token: string }).token)); }}>
              {scim.token ? 'Replace token' : 'Create token'}
            </Button>
            {scim.token && <Button size="sm" variant="ghost" disabled={pending} onClick={() => { if (confirm('Revoke the SCIM token? Provisioning stops at once.')) run(() => revokeScimTokenAction()); }}>Revoke</Button>}
          </div>
        </CardBody>
        {scim.events.length ? (
          <Table>
            <THead><tr><TH>When</TH><TH>Request</TH><TH>Result</TH><TH>Detail</TH></tr></THead>
            <TBody>
              {scim.events.map((e, i) => (
                <TR key={i}>
                  <TD className="whitespace-nowrap text-fg-muted">{when(e.createdAt)}</TD>
                  <TD className="font-mono text-[12px]">{e.method} {e.path}</TD>
                  <TD><Badge tone={e.status < 300 ? 'success' : e.status < 500 ? 'warning' : 'danger'}>{e.status}</Badge></TD>
                  <TD className="text-[13px] text-fg-muted">{e.detail ?? ''}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState title="No provisioning calls yet" description="Calls from your identity provider appear here, with the result of each." />}
      </Card>
    </div>
  );
}
