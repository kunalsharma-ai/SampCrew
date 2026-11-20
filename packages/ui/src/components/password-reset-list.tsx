import { PASSWORD_RESET_LEVEL_LABEL, PASSWORD_RESET_LEVELS, PASSWORD_RESET_STATUS_LABEL, PASSWORD_RESET_STATUSES, type PasswordResetList, type PasswordResetStatus } from '@crew/contracts';
import { buttonClass } from './button';
import { Input, Select } from './form';
import { Badge, Card, EmptyState, Stat, type Tone } from './surface';
import { Table, TBody, TD, TH, THead, TR } from './table';

const STATUS_TONE: Record<PasswordResetStatus, Tone> = {
  pending: 'info', completed: 'success', expired: 'neutral', replaced: 'neutral', locked: 'danger', no_account: 'warning', inactive: 'warning', limited: 'warning',
};
const DELIVERY: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'Waiting to send', tone: 'neutral' },
  sent: { label: 'Delivered to mail server', tone: 'success' },
  failed: { label: 'Not delivered', tone: 'danger' },
  skipped: { label: 'Email not set up', tone: 'warning' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};
const CLIENT: Record<string, string> = { web: 'Web Portal', mobile: 'Phone app', api: 'API', console: 'Console' };

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * The password reset record: summary, filters (a plain GET form, so it works without scripts) and the list. The Console
 * shows every level and workspace; a Super Workspace shows only its own people (no Console level, no workspace column).
 */
export function PasswordResetRecord({
  data,
  query,
  basePath,
  scope,
}: {
  data: PasswordResetList;
  query: { level?: string; status?: string; q?: string; page: number };
  basePath: string;
  scope: 'console' | 'workspace';
}) {
  const levels = PASSWORD_RESET_LEVELS.filter((l) => scope === 'console' || l !== 'console');
  const statuses = PASSWORD_RESET_STATUSES.filter((s) => scope === 'console' || s !== 'no_account');
  const pageSize = 50;
  const pages = Math.max(1, Math.ceil(data.total / pageSize));
  const link = (page: number) => {
    const p = new URLSearchParams();
    if (query.level) p.set('level', query.level);
    if (query.status) p.set('status', query.status);
    if (query.q) p.set('q', query.q);
    if (page > 1) p.set('page', String(page));
    return `${basePath}${p.size ? `?${p}` : ''}`;
  };
  return (
    <div className="grid gap-5" data-testid="password-resets">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Requests, last 30 days" value={data.summary.requested} />
        <Stat label="Passwords changed" value={data.summary.completed} />
        <Stat label="Waiting for the person" value={data.summary.pending} />
        <Stat label="Email not delivered" value={data.summary.failedDelivery} hint={data.summary.failedDelivery ? (scope === 'console' ? 'Check Integrations > Email' : 'Ask SAMPLEDGE to check email delivery') : undefined} />
      </div>
      <form method="get" action={basePath} className="flex flex-wrap items-end gap-2">
        <div className="w-full sm:w-64"><Input name="q" defaultValue={query.q ?? ''} placeholder="Search name or email" aria-label="Search name or email" /></div>
        <div className="w-full sm:w-52">
          <Select name="level" defaultValue={query.level ?? ''} aria-label="Level">
            <option value="">Every level</option>
            {levels.map((l) => <option key={l} value={l}>{PASSWORD_RESET_LEVEL_LABEL[l]}</option>)}
          </Select>
        </div>
        <div className="w-full sm:w-60">
          <Select name="status" defaultValue={query.status ?? ''} aria-label="Status">
            <option value="">Every status</option>
            {statuses.map((s) => <option key={s} value={s}>{PASSWORD_RESET_STATUS_LABEL[s]}</option>)}
          </Select>
        </div>
        <button type="submit" className={buttonClass('secondary')}>Filter</button>
        {(query.q || query.level || query.status) && <a href={basePath} className={buttonClass('ghost')}>Clear</a>}
      </form>
      <Card>
        {data.items.length === 0 ? (
          <EmptyState title="No password resets yet" description="When someone uses &quot;Forgot password?&quot; it appears here straight away." />
        ) : (
          <Table aria-label="Password resets">
            <THead>
              <TR>
                <TH>Asked</TH>
                <TH>Person</TH>
                <TH>Level</TH>
                {scope === 'console' && <TH>Workspace</TH>}
                <TH>Status</TH>
                <TH>Email</TH>
                <TH>From</TH>
              </TR>
            </THead>
            <TBody>
              {data.items.map((r) => (
                <TR key={r.id} data-testid="password-reset-row">
                  <TD className="whitespace-nowrap">{when(r.requestedAt)}</TD>
                  <TD>
                    <div className="font-medium">{r.fullName ?? 'No account'}</div>
                    <div className="text-xs text-fg-subtle">{r.email}</div>
                  </TD>
                  <TD className="whitespace-nowrap">{r.level ? PASSWORD_RESET_LEVEL_LABEL[r.level] : '-'}</TD>
                  {scope === 'console' && (
                    <TD className="text-sm">{r.workspaces.length ? r.workspaces.map((w) => <div key={w.id}><a className="hover:underline" href={`/tenants/${w.id}`}>{w.name}</a> <span className="text-xs text-fg-subtle">{PASSWORD_RESET_LEVEL_LABEL[w.level]}</span></div>) : r.level === 'console' ? 'SAMPLEDGE Console' : '-'}</TD>
                  )}
                  <TD>
                    <Badge tone={STATUS_TONE[r.status]}>{PASSWORD_RESET_STATUS_LABEL[r.status]}</Badge>
                    {r.completedAt && r.sessionsRevoked > 0 && <div className="mt-1 whitespace-nowrap text-xs text-fg-subtle">{r.sessionsRevoked} device{r.sessionsRevoked === 1 ? '' : 's'} signed out</div>}
                  </TD>
                  <TD>
                    {r.delivery ? <Badge tone={DELIVERY[r.delivery]?.tone ?? 'neutral'}>{DELIVERY[r.delivery]?.label ?? r.delivery}</Badge> : <span className="text-xs text-fg-subtle">Not sent</span>}
                    {scope === 'console' && r.deliveryError && r.delivery !== 'sent' && <div className="mt-1 max-w-56 truncate text-xs text-fg-subtle" title={r.deliveryError}>{r.deliveryError}</div>}
                  </TD>
                  <TD className="whitespace-nowrap text-sm text-fg-muted">{CLIENT[r.client] ?? r.client}{r.ip ? <div className="text-xs text-fg-subtle">{r.ip}</div> : null}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      {pages > 1 && (
        <div className="flex items-center justify-between text-sm text-fg-muted">
          <span>Page {query.page} of {pages} ({data.total} requests)</span>
          <span className="flex gap-2">
            {query.page > 1 && <a className={buttonClass('secondary', 'sm')} href={link(query.page - 1)}>Previous</a>}
            {query.page < pages && <a className={buttonClass('secondary', 'sm')} href={link(query.page + 1)}>Next</a>}
          </span>
        </div>
      )}
    </div>
  );
}

/** Reads the list filters from a page's search parameters, ignoring anything that is not a known value. */
export function passwordResetFilters(sp: { level?: string; status?: string; q?: string; page?: string }, scope: 'console' | 'workspace') {
  const level = (PASSWORD_RESET_LEVELS as readonly string[]).includes(sp.level ?? '') && !(scope === 'workspace' && sp.level === 'console') ? sp.level : undefined;
  const status = (PASSWORD_RESET_STATUSES as readonly string[]).includes(sp.status ?? '') ? sp.status : undefined;
  const q = sp.q?.trim().slice(0, 100) || undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const params = new URLSearchParams({ limit: '50', offset: String((page - 1) * 50) });
  if (level) params.set('level', level);
  if (status) params.set('status', status);
  if (q) params.set('q', q);
  return { query: { level, status, q, page }, params: params.toString() };
}
