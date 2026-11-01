'use client';
import type { PublicProposal } from '@crew/contracts';
import { Alert, Button, Card, CardBody, CardHeader, Checkbox, Field, Input, Textarea } from '@crew/ui';
import { useState, useTransition } from 'react';
import { acceptProposalAction, declineProposalAction } from '../actions';

const when = (s: string) => new Date(s).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' });

const CLOSED: Record<string, { title: string; text: string }> = {
  expired: { title: 'This link has expired', text: 'Ask the sender for an up-to-date proposal.' },
  replaced: { title: 'This proposal has been replaced', text: 'A newer version is on its way, or ask the sender for it.' },
  withdrawn: { title: 'This proposal has been withdrawn', text: 'Contact the sender if you would still like to go ahead.' },
  closed: { title: 'This proposal has already been answered', text: 'Someone at your organisation has already responded to it.' },
};

/** Accept with a typed signature, or decline with a reason. */
export function Respond({ token, proposal }: { token: string; proposal: PublicProposal }) {
  const [p, setP] = useState(proposal);
  const [mode, setMode] = useState<'accept' | 'decline'>('accept');
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [name, setName] = useState('');

  if (p.decision) {
    const d = p.decision;
    return d.kind === 'accepted' ? (
      <Alert tone="success" title="Proposal accepted">
        Accepted by {d.by}{d.title ? `, ${d.title}` : ''} on {when(d.at)}. {p.organisation} has been told and will be in touch about next steps. The signed copy is
        available from the download button above.
      </Alert>
    ) : (
      <Alert tone="info" title="Proposal declined">Declined by {d.by} on {when(d.at)}{d.reason ? `: “${d.reason}”` : ''}. Thank you for letting {p.organisation} know.</Alert>
    );
  }
  if (p.status !== 'open') {
    const c = CLOSED[p.status]!;
    return <Alert tone="warning" title={c.title}>{c.text}</Alert>;
  }

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const v = (k: string) => String(f.get(k) ?? '').trim();
    setError(null);
    setFe({});
    start(async () => {
      const r = mode === 'accept'
        ? await acceptProposalAction(token, { signerName: v('signerName'), signerTitle: v('signerTitle'), signerEmail: v('signerEmail'), signature: v('signature'), authorised: f.get('authorised') === 'true' })
        : await declineProposalAction(token, { signerName: v('signerName'), signerEmail: v('signerEmail'), reason: v('reason') });
      if (!r.ok) { setError(r.message); setFe(r.fieldErrors ?? {}); } else if (r.data) setP(r.data);
    });
  };

  return (
    <Card id="respond">
      <CardHeader
        title="Your response"
        description={mode === 'accept' ? `Accepting is a binding agreement to the proposal and terms above, version ${p.version}.` : 'Let us know why, so we can do better next time.'}
        action={(
          <div role="radiogroup" aria-label="Response" className="flex gap-1 rounded-md border border-border p-0.5 text-sm">
            {(['accept', 'decline'] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => { setMode(m); setError(null); setFe({}); }}
                className={`rounded px-3 py-1 ${mode === m ? 'bg-accent text-accent-fg' : 'text-fg-muted hover:text-fg'}`}>
                {m === 'accept' ? 'Accept' : 'Decline'}
              </button>
            ))}
          </div>
        )}
      />
      <CardBody>
        <form key={mode} className="grid grid-cols-2 gap-4" onSubmit={submit}>
          {error && <Alert tone="danger" className="col-span-2">{error}</Alert>}
          <Field label="Your full name" required error={fe.signerName} className="col-span-2 sm:col-span-1">{(f) => <Input {...f} name="signerName" required autoComplete="name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Work email" required error={fe.signerEmail} className="col-span-2 sm:col-span-1">{(f) => <Input {...f} name="signerEmail" type="email" required autoComplete="email" />}</Field>
          {mode === 'accept' ? (
            <>
              <Field label="Job title" required error={fe.signerTitle} className="col-span-2 sm:col-span-1">{(f) => <Input {...f} name="signerTitle" required autoComplete="organization-title" maxLength={120} />}</Field>
              <Field label="Signature" required hint="Type your full name exactly as above" error={fe.signature} className="col-span-2 sm:col-span-1">
                {(f) => <Input {...f} name="signature" required autoComplete="off" maxLength={120} className="font-serif italic" placeholder={name || undefined} />}
              </Field>
              <div className="col-span-2">
                <Checkbox name="authorised" value="true" required label={`I am authorised to accept this proposal on behalf of ${p.clientName}`} />
                {fe.authorised && <p className="mt-1 text-[0.8125rem] text-danger">{fe.authorised}</p>}
              </div>
              <p className="col-span-2 text-xs text-fg-subtle">We record your name, email, the time, your IP address and browser with your signature, and add them to a signed copy of the PDF.</p>
              <div className="col-span-2"><Button type="submit" loading={pending}>Accept and sign</Button></div>
            </>
          ) : (
            <>
              <Field label="Reason" required error={fe.reason} className="col-span-2">{(f) => <Textarea {...f} name="reason" required rows={3} maxLength={1000} />}</Field>
              <div className="col-span-2"><Button type="submit" variant="secondary" loading={pending}>Decline proposal</Button></div>
            </>
          )}
        </form>
      </CardBody>
    </Card>
  );
}
