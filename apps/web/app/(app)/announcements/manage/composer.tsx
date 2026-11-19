'use client';
import { ANNOUNCEMENT_CATEGORIES, ANNOUNCEMENT_CATEGORY_LABELS, ANNOUNCEMENT_PRIORITIES, EMPTY_AUDIENCE, type AnnouncementCategory, type AnnouncementPriority, type AudienceInput } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, Checkbox, Field, Input, Select } from '@crew/ui';
import { CalendarClock, Paperclip, Send, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { AudiencePicker, type AudienceOptions } from '@/components/audience-picker';
import { RichTextEditor } from '@/components/rich-text';
import type { LegalEntity, Location } from '@/lib/types';
import { saveAndPublishAnnouncementAction, saveAnnouncementAction, uploadAnnouncementFileAction } from '../../helpdesk/actions';
import { ANN_PRIORITY_LABEL } from '../../helpdesk/labels';
import type { Announcement, AnnouncementFile } from '../../helpdesk/types';

/** The plain text of an older announcement, as rich text for the editor. */
const textToHtml = (t: string) => t.split(/\n{2,}/).map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`).join('');
/** A local date-time input value ("2026-11-20T09:30") as an ISO time with the browser's offset. */
const toIso = (local: string) => (local ? new Date(local).toISOString() : null);
const toLocal = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

/**
 * Writing or editing an announcement: who it is for, category and priority, rich text, files, acknowledgement,
 * pinning and expiry; then save a draft, publish now or schedule. A published one is edited as a new version.
 */
export function AnnouncementComposer({ a, options, knownNames, entities, locations }: {
  a: Announcement | null;
  options: AudienceOptions;
  knownNames: Record<string, string>;
  entities: LegalEntity[];
  locations: Location[];
}) {
  const router = useRouter();
  const published = a?.status === 'published';
  // Older announcements were addressed to one department; they open with that department chosen.
  const [audience, setAudience] = useState<AudienceInput>(a?.audience ?? (a && (a.departmentId || a.legalEntityId || a.locationId) ? { ...EMPTY_AUDIENCE, departmentIds: a.departmentId ? [a.departmentId] : [], all: !a.departmentId } : a ? { ...EMPTY_AUDIENCE, all: true } : EMPTY_AUDIENCE));
  const [title, setTitle] = useState(a?.title ?? '');
  const [html, setHtml] = useState(a ? (a.html ?? textToHtml(a.body)) : '');
  const [category, setCategory] = useState<AnnouncementCategory>(a?.category ?? 'general');
  const [priority, setPriority] = useState<AnnouncementPriority>(a?.priority ?? 'normal');
  const [entity, setEntity] = useState(a?.legalEntityId ?? '');
  const [location, setLocation] = useState(a?.locationId ?? '');
  const [files, setFiles] = useState<AnnouncementFile[]>(a?.files ?? []);
  const [requiresAck, setRequiresAck] = useState(a?.requiresAck ?? false);
  const [askAgain, setAskAgain] = useState(false);
  const [pinned, setPinned] = useState(a?.pinned ?? false);
  const [expiresOn, setExpiresOn] = useState(a?.expiresOn ?? '');
  const [later, setLater] = useState(a?.status === 'scheduled');
  const [publishAt, setPublishAt] = useState(toLocal(a?.publishAt ?? null));
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  // An older announcement keeps its plain text and addressing unless they are changed here (so pinning it, for
  // example, does not make a new version).
  const [touched, setTouched] = useState({ audience: false, html: false });
  const keepOld = { audience: !!a && !a.audience && !touched.audience, html: !!a && !a.html && !touched.html };
  const body = () => ({
    title: title.trim(), ...(keepOld.html ? { html: null, body: a!.body } : { html }),
    audience: keepOld.audience ? null : audience, departmentId: keepOld.audience ? a!.departmentId : null,
    legalEntityId: entity || null, locationId: location || null, category, priority,
    fileIds: files.map((f) => f.id), requiresAck, pinned, expiresOn: expiresOn || null, askAgain,
  });
  const done = (text: string, id: string) => {
    router.push(`/announcements/manage/${id}?saved=${encodeURIComponent(text)}`);
  };
  const save = () => start(async () => {
    setMsg(null);
    setFe({});
    const r = await saveAnnouncementAction(a?.id ?? null, body());
    if (r.ok) { if (r.data) done(r.message ?? 'Saved.', r.data.id); }
    else { setMsg({ tone: 'danger', text: r.message }); setFe(r.fieldErrors ?? {}); }
  });
  const publish = () => start(async () => {
    setMsg(null);
    setFe({});
    if (later && !publishAt) { setMsg({ tone: 'danger', text: 'Choose when to publish it.' }); return; }
    const r = await saveAndPublishAnnouncementAction(a?.id ?? null, body(), later ? toIso(publishAt) : null);
    if (r.ok) { if (r.data) done(r.message ?? 'Published.', r.data.id); return; }
    const saved = (r as { data?: { id: string } }).data;
    if (r.code === 'saved_not_published' && saved) done(r.message, saved.id);
    else { setMsg({ tone: 'danger', text: r.message }); setFe(r.fieldErrors ?? {}); }
  });
  const attach = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    setMsg(null);
    for (const file of Array.from(list).slice(0, 10 - files.length)) {
      const form = new FormData();
      form.append('file', file);
      const r = await uploadAnnouncementFileAction(form);
      if (r.ok && r.data) { const f = r.data; setFiles((cur) => [...cur, f]); }
      else setMsg({ tone: 'danger', text: `${file.name}: ${r.message}` });
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <Card>
        <CardBody className="grid gap-4">
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
          {published && <Alert tone="info">This announcement is published. Changing the wording, audience or files saves a new version that people see straight away. Pinning, expiry, category and priority change without a new version.</Alert>}
          <Field label="Title" required error={fe.title}>{(p) => <Input {...p} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />}</Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Category">{(p) => <Select {...p} value={category} onChange={(e) => setCategory(e.target.value as AnnouncementCategory)}>{ANNOUNCEMENT_CATEGORIES.map((c) => <option key={c} value={c}>{ANNOUNCEMENT_CATEGORY_LABELS[c]}</option>)}</Select>}</Field>
            <Field label="Priority" hint="Urgent ones also go by email and stand out in the feed">{(p) => <Select {...p} value={priority} onChange={(e) => setPriority(e.target.value as AnnouncementPriority)}>{ANNOUNCEMENT_PRIORITIES.map((x) => <option key={x} value={x}>{ANN_PRIORITY_LABEL[x]}</option>)}</Select>}</Field>
          </div>
          <div className="grid gap-1.5">
            <span className="text-[0.8125rem] font-medium">Message</span>
            <RichTextEditor value={html} onChange={(v) => { if (v !== html) { setHtml(v); setTouched((t) => ({ ...t, html: true })); } }} label="Message" placeholder="Write the announcement" />
            {fe.body && <span className="text-xs text-danger">{fe.body}</span>}
          </div>
          <div className="grid gap-2">
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" loading={uploading} disabled={files.length >= 10} onClick={() => fileRef.current?.click()}><Paperclip className="size-3.5" /> Attach files</Button>
              <span className="text-xs text-fg-muted">PDF, images, Office files; up to 10 MB each</span>
              <input ref={fileRef} type="file" multiple hidden data-testid="announcement-file-input" onChange={(e) => void attach(e.target.files)} />
            </div>
            {files.length > 0 && (
              <ul className="flex flex-wrap gap-1.5" aria-label="Attachments">
                {files.map((f) => <li key={f.id}><Badge>{f.name} <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((cur) => cur.filter((x) => x.id !== f.id))}><X className="size-3" /></button></Badge></li>)}
              </ul>
            )}
          </div>
        </CardBody>
      </Card>
      <div className="grid content-start gap-4">
        <Card>
          <CardBody className="grid gap-3">
            <span className="text-[0.8125rem] font-semibold">Who is it for?</span>
            <AudiencePicker value={audience} onChange={(v) => { setAudience(v); setTouched((t) => ({ ...t, audience: true })); }} options={options} knownNames={knownNames} />
            {(entities.length > 1 || locations.length > 1) && (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
                {entities.length > 1 && <Field label="Only in legal entity">{(p) => <Select {...p} value={entity} onChange={(e) => setEntity(e.target.value)}><option value="">Any</option>{entities.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>}
                {locations.length > 1 && <Field label="Only at location">{(p) => <Select {...p} value={location} onChange={(e) => setLocation(e.target.value)}><option value="">Any</option>{locations.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>}
              </div>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardBody className="grid gap-3">
            <Checkbox label="Ask people to acknowledge it" description="Each person confirms they have read it; you see who has and who has not." checked={requiresAck} onChange={(e) => setRequiresAck(e.target.checked)} />
            {published && a?.requiresAck && requiresAck && <Checkbox label="Ask everyone to acknowledge again" description="If you change the wording, earlier acknowledgements no longer count and people are notified." checked={askAgain} onChange={(e) => setAskAgain(e.target.checked)} />}
            <Checkbox label="Pin to the top of the feed" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
            <Field label="Take off the feed after" hint="Optional">{(p) => <Input {...p} type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />}</Field>
            {!published && (
              <>
                <Checkbox label="Publish later" description="It goes out at the time you choose, and people are notified then." checked={later} onChange={(e) => setLater(e.target.checked)} />
                {later && <Field label="Publish at">{(p) => <Input {...p} type="datetime-local" value={publishAt} min={toLocal(new Date().toISOString())} onChange={(e) => setPublishAt(e.target.value)} />}</Field>}
              </>
            )}
          </CardBody>
        </Card>
        <div className="flex flex-wrap justify-end gap-2">
          {published ? (
            <Button loading={pending} onClick={save} disabled={!title.trim()}>Save changes</Button>
          ) : (
            <>
              <Button variant="secondary" loading={pending} onClick={save} disabled={!title.trim()}>Save draft</Button>
              <Button loading={pending} onClick={publish} disabled={!title.trim()} data-testid="announcement-publish">
                {later ? <><CalendarClock className="size-3.5" /> Schedule</> : <><Send className="size-3.5" /> Publish now</>}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
