'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, EmptyState, Field, Input, Select, Table, TBody, TD, Textarea, TH, THead, TR } from '@crew/ui';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { useRunner } from '../../recruitment/use-runner';
import { SecretOnce } from '../integrations/secret-once';
import { createScimTokenAction, mapScimGroupAction, removeSsoAction, revokeScimTokenAction, saveSsoAction, ssoStatusAction, testSsoAction } from './actions';

export interface SsoConnection {
  id: string;
  protocol: 'oidc' | 'saml';
  issuer: string;
  clientId: string | null;
  samlSsoUrl: string | null;
  samlCertExpiresAt: string | null;
  samlCertFingerprint: string | null;
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
  saml: { entityId: string; acsUrl: string; metadataUrl: string };
}
export interface ScimGroup {
  id: string;
  displayName: string;
  externalId: string | null;
  roleId: string | null;
  roleName: string | null;
  memberCount: number;
  updatedAt: string;
}
export interface RoleOption {
  id: string;
  key: string;
  name: string;
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
      <code data-testid={testId} className="break-all rounded bg-bg-subtle px-2 py-1 font-mono text-[0.75rem] text-fg">{value}</code>
      <Button size="sm" variant="ghost" type="button" onClick={() => { void navigator.clipboard?.writeText(value).catch(() => undefined); setCopied(true); }}>
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

export function SsoView({ sso, scim, groups, roles, tested, failure }: { sso: SsoState; scim: ScimStatus; groups: ScimGroup[]; roles: RoleOption[]; tested: boolean; failure: string | null }) {
  const c = sso.connection;
  const { pending, notice, run } = useRunner();
  const [editing, setEditing] = useState(!c);
  const [protocol, setProtocol] = useState<'oidc' | 'saml'>(c?.protocol ?? 'oidc');
  const [issuer, setIssuer] = useState(c?.protocol === 'oidc' ? c.issuer : '');
  const [entityId, setEntityId] = useState(c?.protocol === 'saml' ? c.issuer : '');
  const [ssoUrl, setSsoUrl] = useState(c?.samlSsoUrl ?? '');
  const [certificate, setCertificate] = useState('');
  const [clientId, setClientId] = useState(c?.clientId ?? '');
  const [secret, setSecret] = useState('');
  const [domains, setDomains] = useState(c?.domains.join(', ') ?? '');
  const [jit, setJit] = useState(c?.jitProvisioning ?? false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const domainList = domains.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
  const samlCertNeeded = !(c?.protocol === 'saml' && c.samlCertFingerprint);
  const valid =
    domainList.length > 0 &&
    (protocol === 'oidc'
      ? /^https?:\/\/\S+$/.test(issuer.trim()) && clientId.trim().length > 0
      : entityId.trim().length > 0 && /^https?:\/\/\S+$/.test(ssoUrl.trim()) && (certificate.trim().length >= 100 || !samlCertNeeded));

  const save = () =>
    run(async () => {
      const r = await saveSsoAction(
        protocol === 'oidc'
          ? { protocol, issuer: issuer.trim(), clientId: clientId.trim(), clientSecret: secret || undefined, domains: domainList, jitProvisioning: jit }
          : { protocol, idpEntityId: entityId.trim(), ssoUrl: ssoUrl.trim(), certificate: certificate.trim() || undefined, domains: domainList, jitProvisioning: jit },
      );
      if (r.ok) {
        setEditing(false);
        setSecret('');
        setCertificate('');
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
      {tested && <Alert tone="success" title="Test sign-in passed">The provider signed you in and SampCrew verified the ID token. You can switch single sign-on on now.</Alert>}
      {failure && <Alert tone="danger" title="Test sign-in failed">{failure}</Alert>}
      {notice && !token && <Alert tone={notice.tone}>{notice.text}</Alert>}

      <Card>
        <CardHeader
          title="Single sign-on"
          description="OpenID Connect or SAML 2.0. Use OpenID Connect when your provider offers both; SAML suits older setups and providers that only offer it."
          action={c && <Badge tone={STATUS[c.status].tone} dot>{STATUS[c.status].label}{c.enforced ? ', required' : ''}</Badge>}
        />
        <CardBody className="grid gap-5">
          {editing && (
            <Field label="Protocol">
              {(p) => (
                <Select {...p} name="protocol" value={protocol} onChange={(e) => setProtocol(e.target.value as 'oidc' | 'saml')}>
                  <option value="oidc">OpenID Connect</option>
                  <option value="saml">SAML 2.0</option>
                </Select>
              )}
            </Field>
          )}
          <div className="grid gap-1">
            <p className="text-[0.8125rem] font-medium text-fg">1. Register SampCrew in your identity provider</p>
            {(editing ? protocol : c?.protocol ?? 'oidc') === 'oidc' ? (
              <>
                <p className="text-[0.8125rem] text-fg-muted">Create a web application with the authorization code flow and this redirect URI, then assign it to the people who should use SampCrew.</p>
                <CopyValue value={sso.redirectUri} testId="redirect-uri" />
              </>
            ) : (
              <>
                <p className="text-[0.8125rem] text-fg-muted">Create a SAML application with these values (or load the metadata URL), send the email address as the NameID, and assign it to the people who should use SampCrew. Sign the assertion.</p>
                <dl className="grid gap-x-6 gap-y-2 text-[0.8125rem] sm:grid-cols-[14rem_1fr]">
                  <dt className="text-fg-muted">Entity ID (audience)</dt><dd><CopyValue value={sso.saml.entityId} testId="saml-entity-id" /></dd>
                  <dt className="text-fg-muted">Assertion Consumer Service URL</dt><dd><CopyValue value={sso.saml.acsUrl} testId="saml-acs-url" /></dd>
                  <dt className="text-fg-muted">Metadata</dt><dd><a className="break-all text-[0.75rem] text-accent underline" href={sso.saml.metadataUrl} target="_blank" rel="noreferrer">{sso.saml.metadataUrl}</a></dd>
                </dl>
              </>
            )}
          </div>

          {c && !editing ? (
            <div className="grid gap-3">
              <p className="text-[0.8125rem] font-medium text-fg">2. Connection</p>
              <dl className="grid gap-x-6 gap-y-2 text-[0.8125rem] sm:grid-cols-[10rem_1fr]">
                <dt className="text-fg-muted">Protocol</dt><dd data-testid="sso-protocol">{c.protocol === 'saml' ? 'SAML 2.0' : 'OpenID Connect'}</dd>
                {c.protocol === 'oidc' ? (
                  <>
                    <dt className="text-fg-muted">Issuer</dt><dd className="break-all font-mono text-[0.75rem]">{c.issuer}</dd>
                    <dt className="text-fg-muted">Client ID</dt><dd className="break-all font-mono text-[0.75rem]">{c.clientId}</dd>
                  </>
                ) : (
                  <>
                    <dt className="text-fg-muted">Provider entity ID</dt><dd className="break-all font-mono text-[0.75rem]">{c.issuer}</dd>
                    <dt className="text-fg-muted">Sign-in URL</dt><dd className="break-all font-mono text-[0.75rem]">{c.samlSsoUrl}</dd>
                    <dt className="text-fg-muted">Certificate</dt>
                    <dd data-testid="saml-cert">
                      <span className="break-all font-mono text-[0.6875rem]">SHA-256 {c.samlCertFingerprint}</span>
                      <br />
                      <span className={c.samlCertExpiresAt && Date.parse(c.samlCertExpiresAt) - Date.now() < 30 * 86_400_000 ? 'text-warning' : 'text-fg-muted'}>
                        Expires {c.samlCertExpiresAt ? new Date(c.samlCertExpiresAt).toLocaleDateString() : 'unknown'}. Paste the new certificate here before it expires, or sign-ins stop.
                      </span>
                    </dd>
                  </>
                )}
                <dt className="text-fg-muted">Email domains</dt><dd>{c.domains.join(', ')}</dd>
                <dt className="text-fg-muted">New people</dt><dd>{c.jitProvisioning ? 'Get an account with the Employee role on first sign-in (within your seat limit)' : 'Must be invited or provisioned first'}</dd>
                <dt className="text-fg-muted">Last test</dt><dd data-testid="sso-verified">{c.verifiedAt ? `Passed ${when(c.verifiedAt)} as ${c.verifiedEmail}` : 'Not tested yet'}</dd>
              </dl>
              <div><Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Change settings</Button></div>
            </div>
          ) : (
            <div className="grid gap-4">
              <p className="text-[0.8125rem] font-medium text-fg">2. Connect it here</p>
              {error && <Alert tone="danger">{error}</Alert>}
              {protocol === 'oidc' ? (
                <>
                  <Field label="Issuer URL" hint="From the provider, for example https://login.microsoftonline.com/<tenant>/v2.0. SampCrew reads its settings from /.well-known/openid-configuration." required>
                    {(p) => <Input {...p} name="issuer" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://" />}
                  </Field>
                  <Field label="Client ID" required>
                    {(p) => <Input {...p} name="clientId" value={clientId} onChange={(e) => setClientId(e.target.value)} />}
                  </Field>
                  <Field label="Client secret" hint={c?.protocol === 'oidc' ? 'Leave blank to keep the stored secret. It is stored encrypted and never shown again.' : 'Stored encrypted and never shown again.'}>
                    {(p) => <Input {...p} name="clientSecret" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />}
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Identity provider entity ID (issuer)" hint="From the provider's SAML settings or metadata, for example http://www.okta.com/exk… or https://sts.windows.net/<tenant>/." required>
                    {(p) => <Input {...p} name="idpEntityId" value={entityId} onChange={(e) => setEntityId(e.target.value)} />}
                  </Field>
                  <Field label="Single sign-on URL" hint="Where people are sent to sign in (HTTP-Redirect binding)." required>
                    {(p) => <Input {...p} name="ssoUrl" value={ssoUrl} onChange={(e) => setSsoUrl(e.target.value)} placeholder="https://" />}
                  </Field>
                  <Field label="Signing certificate" hint={samlCertNeeded ? 'Paste the X.509 certificate (PEM, or the base64 from the metadata). SampCrew checks every response is signed with it.' : 'Leave blank to keep the stored certificate.'} required={samlCertNeeded}>
                    {(p) => <Textarea {...p} name="certificate" rows={5} className="font-mono text-[0.6875rem]" value={certificate} onChange={(e) => setCertificate(e.target.value)} placeholder="-----BEGIN CERTIFICATE-----" />}
                  </Field>
                </>
              )}
              <Field label="Email domains" hint="Comma-separated. People with these addresses are sent to your provider. A domain can belong to one workspace only." required>
                {(p) => <Input {...p} name="domains" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="example.com" />}
              </Field>
              <Checkbox label="Create accounts on first sign-in" description="Someone your provider signs in who has no SampCrew account yet gets one, with the Employee role only. Off: they must be invited or provisioned with SCIM first." checked={jit} onChange={(e) => setJit(e.target.checked)} />
              {c && <Alert tone="warning">Changing the protocol, provider, client or certificate switches single sign-on off until a new test sign-in passes.</Alert>}
              <div className="flex gap-2">
                <Button loading={pending} disabled={!valid} onClick={save}>{protocol === 'oidc' ? 'Save and check provider' : 'Save and check certificate'}</Button>
                {c && <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
              </div>
            </div>
          )}

          {c && !editing && (
            <div className="grid gap-3">
              <p className="text-[0.8125rem] font-medium text-fg">3. Test, then switch on</p>
              <p className="text-[0.8125rem] text-fg-muted">The test sends you to the provider and back without signing anyone in. Use an account with one of the domains above.</p>
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
              <p className="text-xs text-fg-subtle">The SampCrew mobile app signs in through the same provider: people choose “Sign in with single sign-on” in the app.</p>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="User provisioning (SCIM 2.0)"
          description="Your identity provider creates, updates and deactivates SampCrew accounts, and pushes groups. Deactivating someone signs them out at once. You choose below which role each group grants."
          action={<Badge tone={scim.token ? 'success' : 'neutral'}>{scim.provisioned} provisioned</Badge>}
        />
        <CardBody className="grid gap-4">
          {token && <SecretOnce label="SCIM token" value={token} onDone={() => setToken(null)} />}
          <div className="grid gap-1">
            <p className="text-[0.8125rem] text-fg-muted">SCIM base URL</p>
            <CopyValue value={scim.baseUrl} testId="scim-base-url" />
          </div>
          <div className="flex flex-wrap items-center gap-3 text-[0.8125rem]">
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
                  <TD className="font-mono text-[0.75rem]">{e.method} {e.path}</TD>
                  <TD><Badge tone={e.status < 300 ? 'success' : e.status < 500 ? 'warning' : 'danger'}>{e.status}</Badge></TD>
                  <TD className="text-[0.8125rem] text-fg-muted">{e.detail ?? ''}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState title="No provisioning calls yet" description="Calls from your identity provider appear here, with the result of each." />}
      </Card>

      <Card>
        <CardHeader
          title="Groups from your identity provider"
          description="Members of a group hold the role you choose while they are in the group. Your provider decides who is in each group; a group grants nothing until you pick a role here. The owner role cannot be granted by a group, and roles given by hand in SampCrew are never removed by a group."
        />
        {groups.length ? (
          <Table>
            <THead><tr><TH>Group</TH><TH>Members</TH><TH>Grants role</TH></tr></THead>
            <TBody>
              {groups.map((g) => (
                <TR key={g.id} data-testid={`scim-group-${g.displayName}`}>
                  <TD>
                    <span className="font-medium">{g.displayName}</span>
                    {g.externalId && <span className="block font-mono text-[0.6875rem] text-fg-subtle">{g.externalId}</span>}
                  </TD>
                  <TD>{g.memberCount}</TD>
                  <TD>
                    <Select
                      aria-label={`Role for ${g.displayName}`}
                      value={g.roleId ?? ''}
                      disabled={pending}
                      onChange={(e) => {
                        const roleId = e.target.value || null;
                        const label = roleId ? roles.find((r) => r.id === roleId)?.name : 'no role';
                        if (confirm(`Grant ${label} to the ${g.memberCount} members of ${g.displayName}? Changes apply at once.`)) run(() => mapScimGroupAction(g.id, roleId));
                      }}
                    >
                      <option value="">No role</option>
                      {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </Select>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState title="No groups yet" description="When your identity provider pushes groups over SCIM (Okta: Push Groups; Microsoft Entra ID: assign groups to the app), they appear here." />}
      </Card>
    </div>
  );
}
