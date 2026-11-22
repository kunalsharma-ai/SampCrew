'use client';
import type { WorkspaceLimits } from '@crew/contracts';
import { WorkspaceLimitsCard } from '@/components/workspace-limits';
import { useMfaRetry } from '@/components/mfa-step-up';
import { useCreateParam } from '@/lib/use-create-param';
import { Alert, Avatar, Badge, Button, Card, Dialog, EmptyState, Field, Input, Select, StatusPill, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Copy, Search, ShieldCheck, UserPlus, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { SetAccessRequest } from '@crew/contracts';
import { AccessEditor, AccessLabel, accessBody, accessFromMember } from '@/components/access-editor';
import type { Department, LegalEntity, Location, Me, Member, Page } from '@/lib/types';
import { inviteAction, resendInviteAction, setAccessAction, updateMemberAction } from './actions';

interface Props {
  me: Me;
  page: Page<Member>;
  query: { q: string; status: string };
  hrWorkspaces: { id: string; name: string }[];
  departments: Department[];
  entities: LegalEntity[];
  locations: Location[];
  canInvite: boolean;
  canManage: boolean;
  canAssignRoles: boolean;
  /** The company's plan-based Employee Workspace limit (each login is one Employee Workspace). */
  limits: WorkspaceLimits | null;
}

export function PeopleView(props: Props) {
  const { page, query, canInvite, limits } = props;
  const full = !!limits?.employee.reached;
  const router = useRouter();
  const [inviteOpen, setInviteOpen] = useCreateParam('invite');
  const [selected, setSelected] = useState<Member | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  const filter = (patch: Partial<typeof query>) => {
    const next = { ...query, ...patch };
    const qs = new URLSearchParams();
    if (next.q) qs.set('q', next.q);
    if (next.status) qs.set('status', next.status);
    router.push(`/people${qs.size ? `?${qs}` : ''}`);
  };

  return (
    <>
      {limits && canInvite && <div className="mb-4"><WorkspaceLimitsCard limits={limits} only="employee" title="Employee Workspaces on your plan" /></div>}
      {inviteLink && (
        <Alert tone="info" title="Invitation created" className="mb-4">
          An invitation email has been queued. If email delivery is not configured in this environment, share this one-time link instead:
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 font-mono text-[0.6875rem] text-fg">{inviteLink}</code>
            <Button size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(inviteLink)}><Copy className="size-3.5" /> Copy</Button>
          </div>
        </Alert>
      )}
      <Card>
        <div className="flex flex-col gap-3 border-b border-border px-5 py-3 sm:flex-row sm:items-center">
          <form
            className="relative flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              filter({ q: String(new FormData(e.currentTarget).get('q') ?? '') });
            }}
          >
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
            <Input name="q" defaultValue={query.q} placeholder="Search by name, email or title" className="pl-9" aria-label="Search people" />
          </form>
          <Select value={query.status} onChange={(e) => filter({ status: e.target.value })} className="sm:w-40" aria-label="Filter by status">
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="invited">Invited</option>
            <option value="suspended">Suspended</option>
          </Select>
          {canInvite && <Button onClick={() => setInviteOpen(true)} disabled={full} title={full ? `Employee Workspaces limit reached (${limits!.employee.text}). Upgrade the plan to add more.` : undefined} data-testid="invite-people"><UserPlus className="size-4" /> Invite people</Button>}
        </div>
        {page.items.length ? (
          <Table>
            <THead><tr><TH>Name</TH><TH>Department</TH><TH>Location</TH><TH>Manager</TH><TH>Workspace access</TH><TH>Status</TH></tr></THead>
            <TBody>
              {page.items.map((m) => (
                <TR key={m.id} className="cursor-pointer" onClick={() => setSelected(m)}>
                  <TD>
                    <button className="flex items-center gap-3 text-left" onClick={() => setSelected(m)}>
                      <Avatar name={m.fullName} size={32} />
                      <span>
                        <span className="block font-medium">{m.fullName}</span>
                        <span className="block text-xs text-fg-subtle">{m.title ? `${m.title} · ` : ''}{m.email}</span>
                      </span>
                    </button>
                  </TD>
                  <TD className="text-fg-muted">{m.departmentName ?? '—'}</TD>
                  <TD className="text-fg-muted">{m.locationName ?? '—'}</TD>
                  <TD className="text-fg-muted">{m.managerName ?? '—'}</TD>
                  <TD><AccessLabel access={m.access} /></TD>
                  <TD><StatusPill status={m.status} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <EmptyState icon={<Users className="size-5" />} title={query.q || query.status ? 'No one matches these filters' : 'No people yet'} description={canInvite ? 'Invite HR colleagues and managers to start building your workspace.' : undefined} />
        )}
        {page.nextCursor && (
          <div className="flex justify-center border-t border-border p-3">
            <Link className="text-[0.8125rem] font-medium text-accent hover:underline" href={`/people?${new URLSearchParams({ ...(query.q && { q: query.q }), ...(query.status && { status: query.status }), cursor: page.nextCursor })}`}>Next page</Link>
          </div>
        )}
      </Card>
      <InviteDialog {...props} open={inviteOpen} onClose={() => setInviteOpen(false)} onInvited={setInviteLink} />
      {selected && <MemberDialog {...props} member={selected} onClose={() => setSelected(null)} onLink={setInviteLink} />}
    </>
  );
}

function InviteDialog({ open, onClose, onInvited, hrWorkspaces, departments, entities, locations, canAssignRoles, me }: Props & { open: boolean; onClose: () => void; onInvited: (link: string | null) => void }) {
  const router = useRouter();
  const withMfa = useMfaRetry();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [access, setAccess] = useState<SetAccessRequest>({ level: 'employee' });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Invite people"
      description="They receive a one-time link to set a password and join this workspace."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="invite-form" loading={pending}>Send invitation</Button></>}
    >
      <form
        id="invite-form"
        className="grid grid-cols-2 gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const body: Record<string, unknown> = { email: f.get('email'), fullName: f.get('fullName'), access: accessBody(access) };
          for (const k of ['departmentId', 'legalEntityId', 'locationId']) if (f.get(k)) body[k] = f.get(k);
          setError(null);
          setFe({});
          start(async () => {
            const r = await withMfa(() => inviteAction(body));
            if (r.ok) {
              onInvited(r.data?.inviteUrl ?? null);
              onClose();
              router.refresh();
            } else {
              setError(r.code === 'mfa_required' ? 'Giving workspace access needs two-step verification. Verify with your authenticator app, then try again.' : r.message);
              setFe(r.fieldErrors ?? {});
            }
          });
        }}
      >
        {error && <Alert tone="danger" className="col-span-2">{error}</Alert>}
        <Field label="Full name" error={fe.fullName} required className="col-span-2 sm:col-span-1">{(p) => <Input {...p} name="fullName" required />}</Field>
        <Field label="Work email" error={fe.email} required className="col-span-2 sm:col-span-1">{(p) => <Input {...p} name="email" type="email" required />}</Field>
        <Field label="Legal entity" className="col-span-2 sm:col-span-1">{(p) => <Select {...p} name="legalEntityId"><option value="">Default</option>{entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select>}</Field>
        <Field label="Department" className="col-span-2 sm:col-span-1">{(p) => <Select {...p} name="departmentId"><option value="">None</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}</Field>
        <Field label="Location" className="col-span-2">{(p) => <Select {...p} name="locationId"><option value="">None</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>
        <div className="col-span-2">
          {canAssignRoles ? (
            <AccessEditor value={access} onChange={setAccess} canGiveSuper={Boolean(me.levels?.super)} hrWorkspaces={hrWorkspaces} entities={entities} departments={departments} />
          ) : (
            <p className="text-xs text-fg-subtle">You can invite people with Employee Workspace access. A Super Workspace or HR Workspace person who manages access can give more.</p>
          )}
        </div>
      </form>
    </Dialog>
  );
}

function MemberDialog({ member, onClose, onLink, hrWorkspaces, departments, entities, locations, canManage, canAssignRoles, me, page }: Props & { member: Member; onClose: () => void; onLink: (l: string | null) => void }) {
  const router = useRouter();
  const withMfa = useMfaRetry();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [access, setAccess] = useState<SetAccessRequest>(accessFromMember(member.access));
  const run = (fn: () => Promise<{ ok: boolean; message?: string; code?: string }>, success: string) =>
    start(async () => {
      const r = await withMfa(fn);
      setMsg(r.ok ? { tone: 'success', text: success } : { tone: 'danger', text: r.code === 'mfa_required' ? 'This change needs two-step verification. Verify with your authenticator app, then try again.' : (r.message ?? 'Failed') });
      if (r.ok) router.refresh();
    });
  const isSelf = member.id === me.membership.id;
  return (
    <Dialog open onClose={onClose} title={member.fullName} description={`${member.email}${member.title ? ` · ${member.title}` : ''}`} size="lg">
      <div className="flex flex-col gap-6">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <div className="flex flex-wrap items-center gap-2 text-[0.8125rem]">
          <StatusPill status={member.status} />
          {member.mfaEnabled ? <Badge tone="success"><ShieldCheck className="size-3" /> MFA on</Badge> : <Badge>MFA off</Badge>}
          {member.lastLoginAt && <span className="text-fg-subtle">Last sign-in {new Date(member.lastLoginAt).toLocaleString()}</span>}
        </div>

        {canManage && (
          <form
            className="grid grid-cols-2 gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const v = (k: string) => (f.get(k) ? String(f.get(k)) : null);
              run(() => updateMemberAction(member.id, { legalEntityId: v('legalEntityId'), departmentId: v('departmentId'), locationId: v('locationId'), managerMembershipId: v('managerMembershipId') }), 'Placement saved.');
            }}
          >
            <h3 className="col-span-2 text-[0.8125rem] font-semibold">Placement</h3>
            <Field label="Legal entity" className="col-span-2 sm:col-span-1">{(p) => <Select {...p} name="legalEntityId" defaultValue={member.legalEntityId ?? ''}><option value="">None</option>{entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select>}</Field>
            <Field label="Department" className="col-span-2 sm:col-span-1">{(p) => <Select {...p} name="departmentId" defaultValue={member.departmentId ?? ''}><option value="">None</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}</Field>
            <Field label="Location" className="col-span-2 sm:col-span-1">{(p) => <Select {...p} name="locationId" defaultValue={member.locationId ?? ''}><option value="">None</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>
            <Field label="Reports to" className="col-span-2 sm:col-span-1">
              {(p) => (
                <Select {...p} name="managerMembershipId" defaultValue={member.managerMembershipId ?? ''}>
                  <option value="">No manager</option>
                  {page.items.filter((x) => x.id !== member.id && x.status === 'active').map((x) => <option key={x.id} value={x.id}>{x.fullName}</option>)}
                </Select>
              )}
            </Field>
            <div className="col-span-2 flex justify-end"><Button type="submit" variant="secondary" size="sm" loading={pending}>Save placement</Button></div>
          </form>
        )}

        {canAssignRoles && (
          <div className="flex flex-col gap-3">
            <h3 className="text-[0.8125rem] font-semibold">Workspace access</h3>
            <AccessEditor value={access} onChange={setAccess} current={member.access} canGiveSuper={Boolean(me.levels?.super)} disabled={member.access?.fromGroup} hrWorkspaces={hrWorkspaces} entities={entities} departments={departments} />
            <div className="flex justify-end">
              <Button size="sm" variant="secondary" loading={pending} disabled={member.access?.fromGroup} onClick={() => run(() => setAccessAction(member.id, accessBody(access)), 'Workspace access saved.')}>
                Save workspace access
              </Button>
            </div>
          </div>
        )}
        {!canAssignRoles && (
          <div className="flex items-center gap-2 text-[0.8125rem]"><span className="font-medium">Workspace access</span><AccessLabel access={member.access} /></div>
        )}

        {canManage && !isSelf && (
          <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-4">
            {member.status === 'invited' ? (
              <Button variant="secondary" size="sm" loading={pending} onClick={() => start(async () => {
                const r = await resendInviteAction(member.id);
                if (r.ok) { onLink(r.data?.inviteUrl ?? null); onClose(); } else setMsg({ tone: 'danger', text: r.message });
              })}>Create a new invitation link</Button>
            ) : <span />}
            {member.status === 'active' && <Button variant="danger" size="sm" loading={pending} onClick={() => confirm(`Suspend ${member.fullName}? They will be signed out everywhere.`) && run(() => updateMemberAction(member.id, { status: 'suspended' }), 'Member suspended and signed out.')}>Suspend access</Button>}
            {member.status === 'suspended' && <Button variant="secondary" size="sm" loading={pending} onClick={() => run(() => updateMemberAction(member.id, { status: 'active' }), 'Access restored.')}>Restore access</Button>}
          </div>
        )}
      </div>
    </Dialog>
  );
}
