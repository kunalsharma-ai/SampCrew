'use client';
import { EMPTY_AUDIENCE, type AudienceInput, type CommFile, type EmailDraftInput } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, Field, Input } from '@crew/ui';
import { Paperclip, Send, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { AudiencePicker, type AudienceOptions } from '@/components/audience-picker';
import { RichTextEditor } from '@/components/rich-text';
import { deleteDraftAction, saveDraftAction, sendEmailAction, uploadFileAction } from '../actions';

const splitAddresses = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

/** Writing an HR email: audience, Cc and Bcc, rich text and attachments; save as a draft or send. */
export function Compose({ id, initial, files: initialFiles, options, knownNames }: {
  id: string | null;
  initial: { subject: string; html: string; audience: AudienceInput; cc: string[]; bcc: string[] };
  files: CommFile[];
  options: AudienceOptions;
  knownNames: Record<string, string>;
}) {
  const router = useRouter();
  const [draftId, setDraftId] = useState(id);
  const [subject, setSubject] = useState(initial.subject);
  const [html, setHtml] = useState(initial.html);
  const [audience, setAudience] = useState<AudienceInput>(initial.audience ?? EMPTY_AUDIENCE);
  const [cc, setCc] = useState(initial.cc.join(', '));
  const [bcc, setBcc] = useState(initial.bcc.join(', '));
  const [showCopies, setShowCopies] = useState(initial.cc.length + initial.bcc.length > 0);
  const [files, setFiles] = useState<CommFile[]>(initialFiles);
  const [uploading, setUploading] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const body = (): EmailDraftInput => ({ subject: subject.trim(), html, audience, cc: splitAddresses(cc), bcc: splitAddresses(bcc), fileIds: files.map((f) => f.id) });
  const save = () => start(async () => {
    const r = await saveDraftAction(draftId, body());
    if (r.ok) {
      setMsg({ tone: 'success', text: 'Draft saved.' });
      if (!draftId) { setDraftId(r.data!.id); router.replace(`/communication/emails/${r.data!.id}`); }
    } else setMsg({ tone: 'danger', text: r.message });
  });
  const send = () => start(async () => {
    const r = await sendEmailAction(draftId, body());
    setConfirm(false);
    if (r.ok) router.push(`/communication/emails/${r.data!.id}?sent=${r.data!.recipients}`);
    else setMsg({ tone: 'danger', text: r.message });
  });
  const attach = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(list).slice(0, 10 - files.length)) {
        const fd = new FormData();
        fd.set('file', f);
        const r = await uploadFileAction(fd);
        if (r.ok) setFiles((cur) => [...cur, r.data!]);
        else setMsg({ tone: 'danger', text: `${f.name}: ${r.message}` });
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <Card>
      <CardBody className="grid gap-4">
        <div className="grid gap-1.5">
          <span className="text-xs font-medium">To</span>
          <AudiencePicker value={audience} onChange={setAudience} options={options} knownNames={knownNames} />
        </div>
        {showCopies ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Cc" hint="Addresses that get one copy, separated by commas">{(p) => <Input {...p} value={cc} onChange={(e) => setCc(e.target.value)} placeholder="hr@company.com" />}</Field>
            <Field label="Bcc" hint="Like Cc, but nobody sees these">{(p) => <Input {...p} value={bcc} onChange={(e) => setBcc(e.target.value)} />}</Field>
          </div>
        ) : <button type="button" className="justify-self-start text-xs font-medium text-accent hover:underline" onClick={() => setShowCopies(true)}>Add Cc or Bcc</button>}
        <Field label="Subject" required>{(p) => <Input {...p} value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />}</Field>
        <div className="grid gap-1.5">
          <span className="text-xs font-medium">Message</span>
          <RichTextEditor value={html} onChange={setHtml} label="Message" placeholder="Write your message" />
        </div>
        <div className="grid gap-1.5">
          <div className="flex items-center gap-2">
            <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => void attach(e.target.files)} data-testid="email-file-input" />
            <Button size="sm" variant="secondary" loading={uploading} disabled={files.length >= 10} onClick={() => fileRef.current?.click()}><Paperclip className="size-3.5" /> Attach files</Button>
            <span className="text-xs text-fg-muted">Up to 10 files, 10 MB each</span>
          </div>
          {files.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label="Attachments">
              {files.map((f) => <li key={f.id}><Badge>{f.name} <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((cur) => cur.filter((x) => x.id !== f.id))}><X className="size-3" /></button></Badge></li>)}
            </ul>
          )}
        </div>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
          <div className="flex gap-2">
            <Button variant="secondary" loading={pending && !confirm} onClick={save}>Save draft</Button>
            {draftId && <Button variant="ghost" onClick={() => start(async () => { const r = await deleteDraftAction(draftId); if (r.ok) router.push('/communication/emails'); else setMsg({ tone: 'danger', text: r.message }); })}><Trash2 className="size-3.5" /> Delete draft</Button>}
          </div>
          {confirm ? (
            <div className="flex items-center gap-2" data-testid="send-confirm">
              <span className="text-[0.8125rem]">Send it now? It cannot be called back.</span>
              <Button variant="ghost" onClick={() => setConfirm(false)}>Not yet</Button>
              <Button loading={pending} onClick={send}><Send className="size-3.5" /> Yes, send</Button>
            </div>
          ) : <Button onClick={() => setConfirm(true)} disabled={!subject.trim()}><Send className="size-3.5" /> Send</Button>}
        </div>
      </CardBody>
    </Card>
  );
}
