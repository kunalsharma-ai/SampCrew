'use client';
import { Badge, Button, Card, CardHeader, EmptyState, Input, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ResourceDialog } from '@/components/resource-form';
import type { Candidate } from '@/lib/types';
import { addCandidateAction } from '../actions';
import { opts, SOURCE } from '../labels';

const SOURCES = Object.fromEntries(Object.entries(SOURCE).filter(([k]) => k !== 'career_site'));

export function CandidatesView({ candidates, q, canAdd }: { candidates: Candidate[]; q: string; canAdd: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <div className="grid gap-6">
      <form className="flex max-w-md gap-2" onSubmit={(e) => { e.preventDefault(); const v = String(new FormData(e.currentTarget).get('q') ?? '').trim(); router.push(`/recruitment/candidates${v ? `?q=${encodeURIComponent(v)}` : ''}`); }}>
        <Input name="q" defaultValue={q} placeholder="Search by name, email or company" aria-label="Search candidates" />
        <Button type="submit" variant="secondary"><Search className="size-3.5" /> Search</Button>
      </form>
      <Card>
        <CardHeader title={q ? `Candidates matching “${q}”` : 'Candidates'} action={canAdd && <Button size="sm" onClick={() => setOpen(true)}><Plus className="size-3.5" /> Add candidate</Button>} />
        {candidates.length ? (
          <Table>
            <THead><tr><TH>Candidate</TH><TH>Jobs</TH><TH>Source</TH><TH>Last activity</TH></tr></THead>
            <TBody>
              {candidates.map((c) => (
                <TR key={c.id}>
                  <TD>
                    <Link className="font-medium text-accent hover:underline" href={`/recruitment/candidates/${c.id}`}>{c.anonymizedAt ? 'Erased candidate' : `${c.firstName} ${c.lastName}`.trim()}</Link>
                    <div className="text-xs text-fg-muted">{[c.currentTitle, c.currentCompany].filter(Boolean).join(' at ') || c.email}</div>
                    {c.tags.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{c.tags.map((t) => <Badge key={t} tone="neutral">{t}</Badge>)}</div>}
                  </TD>
                  <TD className="text-[13px]">
                    {(c.applications ?? []).map((a, i) => <div key={i}>{a.requisitionTitle} <span className="text-fg-muted">· {a.status === 'active' ? a.stage : a.status}</span></div>)}
                    {!c.applications?.length && <span className="text-fg-muted">Not in a job yet</span>}
                  </TD>
                  <TD>{SOURCE[c.source] ?? c.source}</TD>
                  <TD className="text-fg-muted">{new Date(c.lastActivityAt).toLocaleDateString()}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState title={q ? 'No matches' : 'No candidates yet'} description="Candidates come from your career site or are added by recruiters." />}
      </Card>
      <ResourceDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Add candidate"
        description="Only add people who have shared their details with you to be considered for a job."
        fields={[
          { name: 'firstName', label: 'First name', required: true, half: true },
          { name: 'lastName', label: 'Last name', half: true },
          { name: 'email', label: 'Email', required: true, half: true },
          { name: 'phone', label: 'Phone', half: true },
          { name: 'currentTitle', label: 'Current title', half: true },
          { name: 'currentCompany', label: 'Current company', half: true },
          { name: 'source', label: 'Source', type: 'select', required: true, half: true, options: opts(SOURCES) },
          { name: 'tags', label: 'Tags', half: true, placeholder: 'Comma separated' },
          { name: 'lawfulBasisConfirmed', label: 'I may store this person’s details', type: 'select', required: true, options: [{ value: 'true', label: 'Yes, they shared them with us to be considered' }] },
        ]}
        initial={{ source: 'sourced', lawfulBasisConfirmed: 'true' }}
        submitLabel="Add candidate"
        onSubmit={async (v) => {
          const r = await addCandidateAction(v);
          if (r.ok && r.data) router.push(`/recruitment/candidates/${(r.data as { id: string }).id}`);
          return r;
        }}
      />
    </div>
  );
}
