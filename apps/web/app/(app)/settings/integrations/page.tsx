import { Badge, Card, CardBody, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import type { IntegrationsCatalogue } from './types';

export const metadata: Metadata = { title: 'Integrations' };

const MANAGE: Record<string, string> = { api_keys: '/settings/integrations/api-keys', webhooks: '/settings/integrations/webhooks', slack: '/settings/integrations/slack' };
const COUNT: Record<string, (n: number) => string> = {
  api_keys: (n) => `${n} active key${n === 1 ? '' : 's'}`,
  webhooks: (n) => `${n} endpoint${n === 1 ? '' : 's'}`,
  slack: (n) => `${n} channel${n === 1 ? '' : 's'} connected`,
};

export default async function IntegrationsPage() {
  const cat = await load<IntegrationsCatalogue>('/integrations/catalogue');
  const available = cat.connectors.filter((c) => c.status === 'available');
  const planned = cat.connectors.filter((c) => c.status === 'planned');
  return (
    <>
      <PageHeader title="Integrations" description="Connect SampCrew to your other systems. Only workspace owners can change these, and every change is in the audit trail." />
      <h2 className="mb-3 text-sm font-semibold text-fg">Available now</h2>
      <div className="mb-8 grid gap-4 md:grid-cols-3">
        {available.map((c) => (
          <Link key={c.key} href={MANAGE[c.key] ?? '#'} className="group" data-testid={`connector-${c.key}`}>
            <Card className="h-full transition group-hover:border-border-strong">
              <CardBody className="pt-5">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-[0.9375rem] font-semibold text-fg">{c.name}</h3>
                  <Badge tone={c.count ? 'success' : 'neutral'}>{COUNT[c.key]?.(c.count) ?? c.count}</Badge>
                </div>
                <p className="mt-1 text-[0.8125rem] text-fg-muted">{c.description}</p>
                <p className="mt-3 text-[0.8125rem] font-medium text-accent group-hover:underline">Manage</p>
              </CardBody>
            </Card>
          </Link>
        ))}
      </div>
      <h2 className="mb-1 text-sm font-semibold text-fg">Single sign-on</h2>
      <p className="mb-3 text-[0.8125rem] text-fg-muted">Let people sign in with Okta, Microsoft Entra ID, Google or any OpenID Connect or SAML provider. Set it up step by step, with a test sign-in before anyone depends on it.</p>
      <div className="mb-8 grid gap-4 md:grid-cols-3">
        <Link href="/settings/single-sign-on" className="group" data-testid="connector-sso">
          <Card className="h-full transition group-hover:border-border-strong">
            <CardBody className="pt-5">
              <h3 className="text-[0.9375rem] font-semibold text-fg">Okta, Entra ID, Google and SAML</h3>
              <p className="mt-1 text-[0.8125rem] text-fg-muted">Company sign-in for the web portal and the mobile app, with optional enforcement and user provisioning (SCIM).</p>
              <p className="mt-3 text-[0.8125rem] font-medium text-accent group-hover:underline">Set up</p>
            </CardBody>
          </Card>
        </Link>
      </div>
      <h2 className="mb-1 text-sm font-semibold text-fg">Provided by SAMPLEDGE</h2>
      <p className="mb-3 text-[0.8125rem] text-fg-muted">Services SampCrew runs for every workspace. SAMPLEDGE connects these, so there is nothing for you to set up; this shows which are on.</p>
      <div className="mb-8 grid gap-4 md:grid-cols-3" data-testid="platform-services">
        {cat.platformServices.map((s) => (
          <Card key={s.key} data-testid={`platform-${s.key}`}>
            <CardBody className="pt-5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[0.9375rem] font-semibold text-fg">{s.name}</h3>
                <Badge tone={s.on ? 'success' : 'neutral'} dot>{s.on ? 'On' : 'Off'}</Badge>
              </div>
              <p className="mt-1 text-[0.8125rem] text-fg-muted">{s.description}</p>
              {!s.on && <p className="mt-2 text-xs text-fg-subtle">{s.whenOff}</p>}
            </CardBody>
          </Card>
        ))}
      </div>
      <h2 className="mb-1 text-sm font-semibold text-fg">Planned</h2>
      <p className="mb-3 text-[0.8125rem] text-fg-muted">Not built yet, so they cannot be connected. Until then, outgoing webhooks and API keys let your developers link these systems themselves.</p>
      <div className="grid gap-4 md:grid-cols-3">
        {planned.map((c) => (
          <Card key={c.key} className="opacity-80">
            <CardBody className="pt-5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[0.9375rem] font-semibold text-fg">{c.name}</h3>
                <Badge tone="neutral">Planned</Badge>
              </div>
              <p className="mt-1 text-[0.8125rem] text-fg-muted">{c.description}</p>
              <p className="mt-2 text-xs text-fg-subtle">{c.category}</p>
            </CardBody>
          </Card>
        ))}
      </div>
    </>
  );
}
