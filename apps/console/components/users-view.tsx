'use client';
import type { WorkspaceUserRow } from '@crew/contracts';
import { Alert, Avatar, Badge, Button, Card, Dialog, EmptyState, Field, Input, Select, Table, TBody, TD, TH, THead, TR, Textarea, buttonClass } from '@crew/ui';
import { Globe, KeyRound, LogOut, Mail, PauseCircle, PlayCircle, Search, Smartphone, ToggleRight, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { memberAction } from '@/app/(console)/actions';

type Action = 'suspend' | 'reactivate' | 'sign_out' | 'reset_mfa' | 'resend_invite';
const ACTIONS: Record<Action, { label: string; icon: React.ReactNode; danger?: boolean; explain: string }> = {
  sign_out: { label: 'Sign out everywhere', icon: <LogOut className="size-3.5" />, explain: 'Ends every open session of this person in this workspace, on the web and on phones. They can sign in again.' },
  suspend: { label: 'Suspend', icon: <PauseCircle className="size-3.5" />, danger: true, explain: 'Signs them out and stops them signing in to this workspace until reactivated. Their records are kept.' },
  reactivate: { label: 'Reactivate', icon: <PlayCircle className="size-3.5" />, explain: 'They can sign in to this workspace again.' },
  reset_mfa: { label: 'Reset two-step verification', icon: <KeyRound className="size-3.5" />, danger: true, explain: 'Removes their authenticator and signs them out of every workspace they are in. If a workspace requires two-step verification they set it up again at the next sign-in.' },
  resend_invite: { label: 'Resend invitation', icon: <Mail className="size-3.5" />, explain: 'Emails a new invitation link. Earlier links stop working.' },
};

const actionsFor = (u: WorkspaceUserRow): Action[] =>
  u.status === 'invited' ? ['resend_invite'] : u.status === 'suspended' ? ['reactivate'] : ['sign_out', 'suspend', ...(u.mfaEnabled ? (['reset_mfa'] as const) : [])];

/** People in one workspace or all of them, with what SAMPLEDGE can do to each. Account details only. */
export function UsersView({ data, query, basePath, showWorkspace, pageSize }: {
  data: { items: WorkspaceUserRow[]; total: number; summary: Record<string, number> };
  query: { q: string; status: string; page: number }; basePath: string; showWorkspace: boolean; pageSize: number;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<{ user: WorkspaceUserRow; action: Action } | null>(null);
  const [flash, setFlash] = useState<{ tone: 'success' | 'danger'; text: string; url?: string } | null>(null);
  const href = (extra: Partial<Record<'q' | 'status' | 'page', string>>) => {
    const p = new URLSearchParams(Object.entries({ q: query.q, status: query.status, page: String(query.page), ...extra }).filter(([k, v]) => v && !(k === 'page' && v === '1')));
    return `${basePath}${p.size ? `?${p}` : ''}`;
  };
  const pages = Math.max(1, Math.ceil(data.total / pageSize));
  const sum = data.summary;
  return (
    <div className="grid gap-4">
      {flash && (
        <Alert tone={flash.tone}>
          {flash.text}
          {flash.url && <code className="mt-1 block break-all font-mono text-[11px]">{flash.url}</code>}
        </Alert>
      )}
      <div className="flex flex-wrap gap-2 text-[13px]" aria-label="Summary">
        {(['total', 'active', 'invited', 'suspended', 'withMfa', 'signedIn30d'] as const).map((k) => (
          <span key={k} className="crew-card rounded-full border border-border bg-surface px-3 py-1 text-fg-muted" data-testid={`users-${k}`}>
            <strong className="text-fg tabular-nums">{sum[k] ?? 0}</strong> {{ total: 'people', active: 'active', invited: 'invited', suspended: 'suspended', withMfa: 'with two-step verification', signedIn30d: 'signed in within 30 days' }[k]}
          </span>
        ))}
      </div>
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); router.push(href({ q: String(f.get('q') ?? ''), status: String(f.get('status') ?? ''), page: '1' })); }}>
        <label className="relative w-full max-w-sm">
          <span className="sr-only">Search people</span>
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-fg-subtle" aria-hidden />
          <Input name="q" defaultValue={query.q} className="h-9 pl-8" placeholder={showWorkspace ? 'Name, email or workspace' : 'Name or email'} />
        </label>
        <div className="w-44"><Select name="status" defaultValue={query.status} className="h-9 w-40" aria-label="Status">
          <option value="">Everyone</option><option value="active">Active</option><option value="invited">Invited</option><option value="suspended">Suspended</option>
        </Select></div>
        <Button type="submit" variant="secondary">Search</Button>
      </form>
      <Card>
        {data.items.length === 0 ? <EmptyState icon={<Users className="size-6" />} title="Nobody matches" /> : (
          <Table aria-label="People">
            <THead><TR><TH>Person</TH>{showWorkspace && <TH>Workspace</TH>}<TH>Roles</TH><TH>Status</TH><TH>Sign-in</TH><TH className="text-right">Actions</TH></TR></THead>
            <TBody>
              {data.items.map((u) => (
                <TR key={u.membershipId} data-testid={`user-${u.email}`}>
                  <TD>
                    <div className="flex items-center gap-2.5">
                      <Avatar name={u.fullName} size={30} />
                      <div className="min-w-0"><div className="font-medium text-fg">{u.fullName}</div><div className="truncate text-xs text-fg-subtle">{u.email}</div></div>
                    </div>
                  </TD>
                  {showWorkspace && <TD><Link href={`/tenants/${u.tenantId}/users`} className="hover:underline">{u.tenantName}</Link><div className="font-mono text-[11px] text-fg-subtle">{u.tenantSlug}</div></TD>}
                  <TD className="max-w-[14rem]"><div className="flex flex-wrap gap-1">{u.roles.map((r) => <Badge key={r}>{r}</Badge>)}</div>{u.blockedFeatures.length > 0 && <div className="mt-1 text-[11px] text-warning">{u.blockedFeatures.length} module(s) taken away</div>}</TD>
                  <TD>
                    <Badge tone={u.status === 'active' ? 'success' : u.status === 'invited' ? 'accent' : 'danger'} dot>{u.status}</Badge>
                    {u.accountStatus !== 'active' && <div className="mt-1 text-[11px] text-danger">Account {u.accountStatus}</div>}
                  </TD>
                  <TD className="whitespace-nowrap text-xs text-fg-muted">
                    <div>{u.lastLoginAt ? `Last ${new Date(u.lastLoginAt).toLocaleString()}` : 'Never signed in'}</div>
                    <div className="mt-0.5 flex items-center gap-2" aria-label={`${u.liveSessions.web} web and ${u.liveSessions.mobile} mobile sessions open`}>
                      <span className="inline-flex items-center gap-0.5"><Globe className="size-3" aria-hidden />{u.liveSessions.web}</span>
                      <span className="inline-flex items-center gap-0.5"><Smartphone className="size-3" aria-hidden />{u.liveSessions.mobile}</span>
                      {u.mfaEnabled ? <Badge tone="success">2-step on</Badge> : <Badge>2-step off</Badge>}
                    </div>
                  </TD>
                  <TD className="text-right">
                    <div className="flex flex-wrap justify-end gap-1">
                      {actionsFor(u).map((a) => (
                        <Button key={a} size="sm" variant={ACTIONS[a].danger ? 'ghost' : 'secondary'} onClick={() => setDialog({ user: u, action: a })} data-testid={`act-${a}-${u.email}`}>{ACTIONS[a].icon}{ACTIONS[a].label}</Button>
                      ))}
                      {u.status !== 'invited' && <Link className={buttonClass('ghost', 'sm')} href={`/tenants/${u.tenantId}/access?tab=people&q=${encodeURIComponent(u.email)}`}><ToggleRight className="size-3.5" />Modules</Link>}
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      {pages > 1 && (
        <nav aria-label="Pages" className="flex items-center justify-between text-[13px] text-fg-muted">
          <span>Page {query.page} of {pages} · {data.total} people</span>
          <span className="flex gap-2">
            {query.page > 1 && <Link className={buttonClass('secondary', 'sm')} href={href({ page: String(query.page - 1) })}>Previous</Link>}
            {query.page < pages && <Link className={buttonClass('secondary', 'sm')} href={href({ page: String(query.page + 1) })}>Next</Link>}
          </span>
        </nav>
      )}
      {dialog && <ActionDialog {...dialog} onClose={() => setDialog(null)} onDone={(f) => { setFlash(f); setDialog(null); router.refresh(); }} />}
    </div>
  );
}

function ActionDialog({ user, action, onClose, onDone }: { user: WorkspaceUserRow; action: Action; onClose: () => void; onDone: (f: { tone: 'success' | 'danger'; text: string; url?: string }) => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const a = ACTIONS[action];
  const short = reason.trim().length < 5;
  return (
    <Dialog open onClose={onClose} title={`${a.label}: ${user.fullName}`} description={a.explain}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={a.danger ? 'danger' : 'primary'} disabled={short} loading={pending} onClick={() => start(async () => {
        const r = await memberAction(user.tenantId, user.membershipId, action, reason.trim());
        if (!r.ok) { setError(r.message); return; }
        const ended = r.data?.sessionsEnded;
        onDone({ tone: 'success', text: `${a.label} done for ${user.fullName}.${ended !== undefined ? ` ${ended} session(s) ended.` : ''}${r.data?.inviteUrl ? ' Local environment: the invitation link is below.' : ''}`, url: r.data?.inviteUrl });
      })}>{a.label}</Button></>}>
      <div className="grid gap-3">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Reason" hint="Recorded in the platform audit log and in the customer's own audit trail." error={reason && short ? 'At least 5 characters' : undefined} required>
          {(p) => <Textarea {...p} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Ticket #1234: the customer's HR asked us to" />}
        </Field>
      </div>
    </Dialog>
  );
}
