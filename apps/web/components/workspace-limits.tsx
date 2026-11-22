import { WORKSPACE_LIMIT_HINT, workspaceLimitAdvice, type WorkspaceLimitKind, type WorkspaceLimits, type WorkspaceLimitUsage } from '@crew/contracts';
import { Alert, buttonClass, Card, CardBody, CardHeader, cn } from '@crew/ui';
import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';

/** Where the upgrade option leads: Plan & billing, opened on the plans and add-ons that give more of this limit. */
export const workspaceLimitUpgradeHref = (kind: WorkspaceLimitKind) => `/settings/billing?limit=${kind === 'hr' ? 'max_hr_workspaces' : 'max_employee_workspaces'}`;

function Meter({ u }: { u: WorkspaceLimitUsage }) {
  const pct = u.limit === null ? 0 : u.limit === 0 ? 100 : Math.min(100, Math.round((u.used / u.limit) * 100));
  const tone = u.reached ? 'bg-danger' : pct >= 80 ? 'bg-warning' : 'bg-accent';
  return (
    <div data-testid={`workspace-limit-${u.kind}`} data-used={u.used} data-limit={u.limit ?? ''} data-reached={u.reached}>
      <div className="flex items-baseline justify-between gap-2 text-[0.8125rem]">
        <span className="font-medium">{u.label}</span>
        <span className="tabular text-[1.0625rem] font-semibold" data-testid={`workspace-limit-${u.kind}-text`}>{u.text}</span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-bg-subtle" role="progressbar" aria-label={`${u.label} used`} aria-valuemin={0} aria-valuemax={u.limit ?? undefined} aria-valuenow={u.used}>
        {u.limit !== null && <div className={cn('h-full rounded-full', tone)} style={{ width: `${pct}%` }} />}
      </div>
      <div className="mt-1 text-xs text-fg-muted">
        {u.limit === null ? 'Unlimited on your plan.' : u.over ? `${u.used - u.limit} more than your plan now allows. Nothing was removed; you cannot add more.` : u.reached ? 'Limit reached.' : `${u.remaining} left on your plan.`}
        {' '}{WORKSPACE_LIMIT_HINT[u.kind]}
      </div>
    </div>
  );
}

/** What to do when a limit is reached: upgrade or add more (billing admins), or who to ask (everyone else). */
export function WorkspaceLimitReached({ limits, kind, className }: { limits: WorkspaceLimits; kind: WorkspaceLimitKind; className?: string }) {
  const u = limits[kind];
  if (!u.reached || u.limit === null) return null;
  const plan = limits.upgrade.plans.find((p) => p[kind] === null || p[kind]! > u.limit!);
  const addon = limits.upgrade.addons.find((a) => a.kind === kind);
  return (
    <Alert tone="warning" title={`${u.label} limit reached (${u.text})`} className={className}>
      <span data-testid={`workspace-limit-${kind}-reached`}>{workspaceLimitAdvice(kind, u.used, u.limit)}</span>
      {limits.upgrade.canManageBilling ? (
        <span className="mt-2 flex flex-wrap items-center gap-2">
          <Link href={workspaceLimitUpgradeHref(kind)} className={buttonClass('primary', 'sm')} data-testid={`workspace-limit-${kind}-upgrade`}>
            {plan ? `${plan.higherTier ? 'Upgrade to' : 'Move to'} ${plan.name}${plan[kind] === null ? ' (unlimited)' : ` (${plan[kind]})`}` : 'Increase the limit'}<ArrowUpRight className="size-3.5" aria-hidden />
          </Link>
          {addon && <Link href={workspaceLimitUpgradeHref(kind)} className={buttonClass('secondary', 'sm')}>Buy {addon.name}</Link>}
        </span>
      ) : (
        <span className="mt-1 block">Ask a Super Workspace person who looks after billing to upgrade the plan.</span>
      )}
    </Alert>
  );
}

/** HR Workspaces and Employee Workspaces: Used / Maximum Allowed, carried from the company's plan. */
export function WorkspaceLimitsCard({ limits, only, title = 'Workspace limits' }: { limits: WorkspaceLimits; only?: WorkspaceLimitKind; title?: string }) {
  const kinds: WorkspaceLimitKind[] = only ? [only] : ['hr', 'employee'];
  return (
    <Card data-testid="workspace-limits">
      <CardHeader
        title={title}
        description={`From your ${limits.plan ? `${limits.plan.name} plan` : 'plan'}, set by SAMPLEDGE. They change on their own when the plan changes or you upgrade.`}
        action={limits.upgrade.canManageBilling ? <Link href={workspaceLimitUpgradeHref(only ?? 'hr')} className={buttonClass('secondary', 'sm')}>Plan & billing</Link> : undefined}
      />
      <CardBody className="grid gap-5">
        <div className={cn('grid gap-5', kinds.length > 1 && 'md:grid-cols-2')}>
          {kinds.map((k) => <Meter key={k} u={limits[k]} />)}
        </div>
        {kinds.map((k) => <WorkspaceLimitReached key={k} limits={limits} kind={k} />)}
      </CardBody>
    </Card>
  );
}
