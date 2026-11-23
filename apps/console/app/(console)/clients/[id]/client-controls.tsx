'use client';
import { Alert, Button, Card, CardBody, CardHeader, Dialog, Field, Select, Textarea } from '@crew/ui';
import { Archive, ArchiveRestore, Copy, Pencil, Plus, RefreshCw, Shuffle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { addClientWorkspaceAction, applyLookupAction, archiveClientAction, lookupClientAction, moveWorkspaceAction, saveClientProfileAction } from '../../console-actions';
import type { ClientDetail } from '../client-types';
import { ProfileFields, readProfile } from '../profile-fields';
import { WorkspaceFields, createdNote, readWorkspace } from '../workspace-fields';

export function EditProfileButton({ c, managers }: { c: ClientDetail; managers: { id: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const masked = c.profile.piiMasked;
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} data-testid="client-edit"><Pencil className="size-4" aria-hidden />Edit profile</Button>
      {open && (
        <Dialog open onClose={() => setOpen(false)} title="Edit company profile" size="lg" description="Type what the client told you. Public details can also be fetched from Brandfetch on the Overview."
          footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" form="client-profile" loading={pending}>Save profile</Button></>}>
          <form id="client-profile" onSubmit={(e) => {
            e.preventDefault();
            const r = readProfile(e.currentTarget, masked);
            if (!r.ok) { setErrors(r.errors); return; }
            setErrors({});
            start(async () => {
              const res = await saveClientProfileAction(c.profile.id, r.data);
              if (!res.ok) { setError(res.message ?? 'Not saved'); setErrors(res.fieldErrors ?? {}); return; }
              setOpen(false);
              router.refresh();
            });
          }} className="grid gap-3">
            {error && <Alert tone="danger">{error}</Alert>}
            <ProfileFields p={c.profile} errors={errors} masked={masked} managers={managers} />
          </form>
        </Dialog>
      )}
    </>
  );
}

type Facts = { domain: string; name: string | null; description: string | null; logoUrl: string | null; linkedin: string | null; foundedYear: number | null; city: string | null; country: string | null; employees: string | null; industries: string[] };
const LOOKUP_FIELDS = [
  { key: 'description', label: 'Description', show: (f: Facts) => f.description, now: (c: ClientDetail) => c.profile.description },
  { key: 'logo', label: 'Logo', show: (f: Facts) => f.logoUrl, now: (c: ClientDetail) => c.profile.logoUrl },
  { key: 'linkedin', label: 'LinkedIn', show: (f: Facts) => f.linkedin, now: (c: ClientDetail) => c.profile.linkedin },
  { key: 'foundedYear', label: 'Year founded', show: (f: Facts) => (f.foundedYear ? String(f.foundedYear) : null), now: (c: ClientDetail) => (c.profile.foundedYear ? String(c.profile.foundedYear) : null) },
  { key: 'location', label: 'City and country', show: (f: Facts) => [f.city, f.country].filter(Boolean).join(', ') || null, now: (c: ClientDetail) => [c.profile.address?.city, c.profile.address?.country].filter(Boolean).join(', ') || null },
] as const;

/**
 * Public company details from the company-data integration (Brandfetch), shown next to what the profile holds. Only
 * what Brandfetch returns can be saved, field by field, marked with its source. Nothing is guessed or invented.
 */
export function LookupCard({ c, canManage }: { c: ClientDetail; canManage: boolean }) {
  const router = useRouter();
  const [facts, setFacts] = useState<{ facts: Facts; fetchedAt: string } | null>(null);
  const [pick, setPick] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ tone: 'danger' | 'success'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const sourced = Object.entries(c.profile.fieldSources).filter(([, v]) => v?.source);
  return (
    <Card data-testid="client-lookup">
      <CardHeader title="Public company data" description="Looked up by the company website in Brandfetch (Console > Integrations). Saved fields show their source." action={canManage ? (
        <Button size="sm" variant="secondary" loading={pending && !facts} disabled={!c.profile.website} title={c.profile.website ? undefined : 'Add the website first'} onClick={() => start(async () => {
          setMsg(null);
          const r = await lookupClientAction(c.profile.id);
          if (!r.ok) { setMsg({ tone: 'danger', text: r.message ?? 'Lookup failed' }); return; }
          const f = r.data!.facts as unknown as Facts;
          setFacts({ facts: f, fetchedAt: r.data!.fetchedAt });
          setPick(LOOKUP_FIELDS.filter((x) => x.show(f) && !x.now(c)).map((x) => x.key));
        })}><RefreshCw className="size-3.5" aria-hidden />Look up</Button>
      ) : undefined} />
      <CardBody className="grid gap-3 text-[13px]">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        {!c.profile.website && <p className="text-fg-muted">Add the company website to look up its public details.</p>}
        {sourced.length > 0 && <p className="text-[12px] text-fg-subtle">From Brandfetch: {sourced.map(([k, v]) => `${k.replace(/_/g, ' ')} (${v?.at?.slice(0, 10) ?? ''})`).join(', ')}.</p>}
        {facts && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[12.5px]">
                <thead className="text-fg-muted"><tr><th className="py-1 pr-2" /><th className="py-1 pr-2">Field</th><th className="py-1 pr-2">Brandfetch</th><th className="py-1">Profile now</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {LOOKUP_FIELDS.map((x) => {
                    const v = x.show(facts.facts);
                    return (
                      <tr key={x.key}>
                        <td className="py-1.5 pr-2"><input type="checkbox" aria-label={`Save ${x.label}`} disabled={!v} checked={pick.includes(x.key)} onChange={(e) => setPick(e.target.checked ? [...pick, x.key] : pick.filter((k) => k !== x.key))} /></td>
                        <td className="py-1.5 pr-2 font-medium">{x.label}</td>
                        <td className="max-w-xs py-1.5 pr-2">{v ? (x.key === 'logo' ? <img src={v} alt="" className="h-8 w-8 rounded object-contain" /> : <span className="line-clamp-3">{v}</span>) : <span className="text-fg-subtle">Not found</span>}</td>
                        <td className="max-w-xs py-1.5 text-fg-muted">{x.now(c) ? (x.key === 'logo' ? <img src={x.now(c)!} alt="" className="h-8 w-8 rounded object-contain" /> : <span className="line-clamp-3">{x.now(c)}</span>) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {(facts.facts.employees || facts.facts.industries.length > 0) && <p className="text-[12px] text-fg-subtle">Brandfetch also lists {[facts.facts.employees ? `${facts.facts.employees} employees` : null, facts.facts.industries.length ? facts.facts.industries.join(', ') : null].filter(Boolean).join(' and ')}. Set size and industry yourself in Edit profile if they fit.</p>}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setFacts(null)}>Discard</Button>
              <Button size="sm" disabled={!pick.length} loading={pending} onClick={() => start(async () => {
                const r = await applyLookupAction(c.profile.id, pick);
                if (!r.ok) { setMsg({ tone: 'danger', text: r.message ?? 'Not saved' }); return; }
                setFacts(null);
                setMsg({ tone: 'success', text: 'Saved from Brandfetch.' });
                router.refresh();
              })} data-testid="lookup-apply">Save chosen fields</Button>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

export function ArchiveButton({ c }: { c: ClientDetail }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const archived = !!c.profile.archivedAt;
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>{archived ? <ArchiveRestore className="size-4" aria-hidden /> : <Archive className="size-4" aria-hidden />}{archived ? 'Restore' : 'Archive'}</Button>
      {open && (
        <Dialog open onClose={() => setOpen(false)} title={archived ? 'Restore this company' : 'Archive this company'}
          description={archived ? 'It comes back into the active lists.' : 'Archiving takes the company out of the active lists. Every record, invoice and workspace is kept. Suspend its Super Workspaces first.'}
          footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant={archived ? 'primary' : 'danger'} disabled={reason.trim().length < 3} loading={pending} onClick={() => start(async () => {
            const r = await archiveClientAction(c.profile.id, !archived, reason.trim());
            if (!r.ok) { setError(r.message ?? 'Not changed'); return; }
            setOpen(false);
            router.refresh();
          })}>{archived ? 'Restore' : 'Archive'}</Button></>}>
          {error && <Alert tone="danger" className="mb-3">{error}</Alert>}
          <Field label="Reason" hint="Saved in the audit log" required>{(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} />}</Field>
        </Dialog>
      )}
    </>
  );
}

export function AddWorkspaceButton({ c, plans }: { c: ClientDetail; plans: { key: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ note: string; url?: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <>
      <Button onClick={() => { setOpen(true); setDone(null); }} data-testid="add-workspace"><Plus className="size-4" aria-hidden />Add Super Workspace</Button>
      {open && (
        <Dialog open onClose={() => setOpen(false)} title={`Add a Super Workspace to ${c.profile.name}`} size="lg" description="For a group with several legal entities or countries. Each Super Workspace has its own subscription, HR Workspaces and people."
          footer={done ? <Button onClick={() => setOpen(false)}>Done</Button> : <><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" form="add-workspace" loading={pending}>Create Super Workspace</Button></>}>
          {done ? (
            <Alert tone="success" title="Super Workspace created">
              {done.note}
              {done.url && <span className="mt-2 flex flex-wrap items-center gap-2"><code className="max-w-full truncate rounded bg-surface px-2 py-0.5 font-mono text-[11px]">{done.url}</code><Button size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(done.url!)}><Copy className="size-3.5" />Copy</Button></span>}
            </Alert>
          ) : (
            <form id="add-workspace" className="grid gap-3" onSubmit={(e) => {
              e.preventDefault();
              const r = readWorkspace(e.currentTarget);
              if (!r.ok) { setErrors(r.errors); return; }
              setErrors({});
              start(async () => {
                const res = await addClientWorkspaceAction(c.profile.id, r.data);
                if (!res.ok) { setError(res.message ?? 'Not created'); setErrors(res.fieldErrors ?? {}); return; }
                const d = res.data as { ownerInviteUrl?: string; ownerAccess?: string; emailDelivery?: string };
                setDone({ note: createdNote({ ownerAccess: d.ownerAccess ?? 'invitation', ownerInviteUrl: d.ownerInviteUrl, emailDelivery: d.emailDelivery }), url: d.ownerInviteUrl });
                router.refresh();
              });
            }}>
              {error && <Alert tone="danger">{error}</Alert>}
              <WorkspaceFields errors={errors} plans={plans} defaults={{ companyName: c.profile.name, countryCode: c.profile.countryCode ?? undefined }} />
            </form>
          )}
        </Dialog>
      )}
    </>
  );
}

export function MoveWorkspaceButton({ tenantId, name, from, options }: { tenantId: string; name: string; from: string; options: { id: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}><Shuffle className="size-3.5" aria-hidden />Move</Button>
      {open && (
        <Dialog open onClose={() => setOpen(false)} title={`Move ${name}`} description="Moves this Super Workspace, with everything in it, to another company. Use it when two records turn out to be one group, or a group splits."
          footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!to} loading={pending} onClick={() => start(async () => {
            const r = await moveWorkspaceAction(tenantId, to, from);
            if (!r.ok) { setError(r.message ?? 'Not moved'); return; }
            setOpen(false);
            router.push(`/clients/${to}/workspaces`);
          })}>Move</Button></>}>
          {error && <Alert tone="danger" className="mb-3">{error}</Alert>}
          <Field label="Move to company">{(p) => <Select {...p} value={to} onChange={(e) => setTo(e.target.value)}><option value="">Choose a company</option>{options.filter((o) => o.id !== from).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>}</Field>
        </Dialog>
      )}
    </>
  );
}

