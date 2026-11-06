'use client';
import { BANNER_ICONS, bannerWindow, type CompanyBanner, OCCASIONS, occasionByKey, occasionWindow, SAMPLE_SIGNATURE, signatureBannerInput } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, Dialog, Field, Input, Select } from '@crew/ui';
import { ImageUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { deleteBannerAction, removeBannerImageAction, saveBannerAction, uploadBannerImageAction } from '../actions';
import { SignaturePreview } from '../preview';
import { bannerImageUrl } from '../types';
import { dateRange } from '../wishes-card';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif'];
interface Form { occasionKey: string | null; title: string; message: string; icon: string; bgColor: string; fgColor: string; linkUrl: string; startsOn: string; endsOn: string; position: 'above' | 'below'; enabled: boolean }

const fromBanner = (b: CompanyBanner): Form => ({
  occasionKey: b.occasionKey, title: b.title, message: b.message, icon: b.icon ?? '', bgColor: b.bgColor, fgColor: b.fgColor, linkUrl: b.linkUrl ?? '',
  startsOn: b.startsOn ?? '', endsOn: b.endsOn ?? '', position: b.position, enabled: b.enabled,
});
const fromOccasion = (key: string): Form => {
  const o = occasionByKey(key)!;
  return { occasionKey: key, title: o.name, message: o.message, icon: o.icon, bgColor: o.bgColor, fgColor: o.fgColor, linkUrl: '', startsOn: '', endsOn: '', position: 'below', enabled: true };
};
const blank = (today: string, brand: string): Form => ({ occasionKey: null, title: '', message: '', icon: '🎉', bgColor: brand, fgColor: '#FFFFFF', linkUrl: '', startsOn: today, endsOn: today, position: 'below', enabled: true });

/** Company festival, celebration and custom banners: what shows under everyone's signature, and when. */
export function BannersManager({ banners, today, brandColor }: { banners: CompanyBanner[]; today: string; brandColor: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; form: Form } | null>(null);
  const byOccasion = new Map(banners.filter((b) => b.occasionKey).map((b) => [b.occasionKey!, b]));
  const custom = banners.filter((b) => !b.occasionKey);
  const live = (b: CompanyBanner) => { const w = bannerWindow(b, today); return !!w && b.enabled && w.from <= today && today <= w.to; };
  const done = (r: { ok: boolean; message?: string }) => { setMsg(r.ok ? { tone: 'success', text: r.message! } : { tone: 'danger', text: r.message! }); router.refresh(); };

  return (
    <Card aria-label="Festivals and celebrations">
      <CardHeader
        title="Festivals and celebrations"
        description="Banners under everyone's signature: festivals from around the world in your words, and your own banners with an image, GIF or link. Each shows on its dates; people can turn company banners off for themselves."
        action={<Button size="sm" onClick={() => setEditing({ id: null, form: blank(today, brandColor) })}><Plus className="size-3.5" /> New banner</Button>}
      />
      <CardBody className="space-y-5 text-[0.8125rem]">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

        <section aria-label="Your banners" className="space-y-2">
          <h3 className="font-medium text-fg">Your banners</h3>
          {custom.length === 0 && byOccasion.size === 0 ? <p className="text-fg-muted">None yet. Add a festival below, or a banner of your own.</p> : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {[...custom, ...byOccasion.values()].map((b) => {
                const w = bannerWindow(b, today);
                return (
                  <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 p-3" data-testid="banner-row">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 font-medium text-fg">
                        {b.icon && <span aria-hidden>{b.icon}</span>}{b.title}
                        {live(b) ? <Badge tone="success">Showing now</Badge> : !b.enabled ? <Badge tone="neutral">Off</Badge> : null}
                        {b.image && <Badge tone="info">{b.image.contentType === 'image/gif' ? 'GIF' : 'Image'}</Badge>}
                      </div>
                      <div className="text-xs text-fg-subtle">{b.message} · {w ? dateRange(w.from, w.to) : 'No date this year'}{b.occasionKey && !b.startsOn ? ' (festival dates)' : ''}</div>
                    </div>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" aria-label={`Edit ${b.title}`} onClick={() => setEditing({ id: b.id, form: fromBanner(b) })}><Pencil className="size-3.5" /></Button>
                      <Button size="sm" variant="ghost" aria-label={`Delete ${b.title}`} disabled={pending} onClick={() => start(async () => done(await deleteBannerAction(b.id)))}><Trash2 className="size-3.5" /></Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-label="Festival library" className="space-y-2">
          <h3 className="font-medium text-fg">Festival library</h3>
          <p className="text-xs text-fg-subtle">Add a festival for everyone, then change its wording, colours or image. Moon-calendar dates are known to 2028 and can differ by a day locally; set your own dates if they do.</p>
          <div className="grid max-h-96 gap-1 overflow-y-auto rounded-lg border border-border p-2 sm:grid-cols-2">
            {OCCASIONS.map((o) => ({ o, w: occasionWindow(o, today) })).sort((p, q) => (p.w?.from ?? '9999').localeCompare(q.w?.from ?? '9999')).map(({ o, w }) => {
              const b = byOccasion.get(o.key);
              return (
                <div key={o.key} className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 hover:bg-bg-subtle">
                  <div className="min-w-0">
                    <div className="text-fg"><span aria-hidden>{o.icon}</span> {o.name}</div>
                    <div className="text-xs text-fg-subtle">{o.region}{w ? ` · ${dateRange(w.from, w.to)}` : ''}</div>
                  </div>
                  {b ? <Badge tone="success">Added</Badge> : (
                    <Button size="sm" variant="secondary" aria-label={`Add ${o.name}`} onClick={() => setEditing({ id: null, form: fromOccasion(o.key) })}>Add</Button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </CardBody>

      {editing && (
        <BannerDialog
          key={editing.id ?? editing.form.occasionKey ?? 'new'}
          id={editing.id}
          initial={editing.form}
          banner={editing.id ? banners.find((b) => b.id === editing.id) ?? null : null}
          today={today}
          onClose={() => setEditing(null)}
          onSaved={(text) => { setMsg({ tone: 'success', text }); router.refresh(); }}
        />
      )}
    </Card>
  );
}

function BannerDialog({ id, initial, banner, today, onClose, onSaved }: {
  id: string | null; initial: Form; banner: CompanyBanner | null; today: string; onClose: () => void; onSaved: (text: string) => void;
}) {
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [file, setFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const occasion = form.occasionKey ? occasionByKey(form.occasionKey) : null;
  const festivalDates = occasion ? occasionWindow(occasion, today) : null;
  const text = (k: 'title' | 'message' | 'linkUrl' | 'bgColor' | 'fgColor' | 'startsOn' | 'endsOn') => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const hex = (v: string, f: string) => (/^#[0-9a-f]{6}$/i.test(v) ? v : f);
  const imageSrc = !file && banner?.image ? bannerImageUrl(banner) : null;
  const preview = {
    ...SAMPLE_SIGNATURE, brandColor: '#1F3A93', accentColor: '#E8833A', font: 'Arial' as const, size: 'medium' as const,
    banner: form.message ? { message: form.message, icon: form.icon || null, bgColor: hex(form.bgColor, '#1F3A93'), fgColor: hex(form.fgColor, '#FFFFFF'), linkUrl: form.linkUrl || null, position: form.position, imageSrc, imageWidth: banner?.image?.width ?? null, imageHeight: banner?.image?.height ?? null } : null,
  };

  const pick = (f: File) => {
    if (!IMAGE_TYPES.includes(f.type)) return setError('Use a PNG, JPEG or GIF image.');
    if (f.size > 1024 * 1024) return setError('Banner images can be up to 1 MB.');
    setError(null);
    setFile(f);
    setFilePreview(URL.createObjectURL(f));
  };

  const save = () => {
    const parsed = signatureBannerInput.safeParse(form);
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])));
      return;
    }
    setErrors({});
    start(async () => {
      const r = await saveBannerAction(id, parsed.data);
      if (!r.ok) {
        setError(r.message);
        if (r.fieldErrors) setErrors(r.fieldErrors);
        return;
      }
      if (file) {
        const fd = new FormData();
        fd.set('file', file, file.name);
        const up = await uploadBannerImageAction(r.data!.id, fd);
        if (!up.ok) return setError(`The banner is saved, but the image was not: ${up.message}`);
      }
      onSaved(r.message!);
      onClose();
    });
  };

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={id ? `Edit ${initial.title || 'banner'}` : occasion ? `Add ${occasion.name}` : 'New banner'}
      description={occasion ? `${occasion.region}. Follows the festival dates${festivalDates ? ` (${dateRange(festivalDates.from, festivalDates.to)})` : ''} unless you set your own.` : 'Shows under everyone\'s signature between the dates you choose.'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>{id ? 'Save banner' : 'Add banner'}</Button></>}
    >
      <div className="grid gap-4 text-[0.8125rem]">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Banner name" hint="Only admins see this." error={errors.title}>{(p) => <Input {...p} value={form.title} maxLength={80} onChange={text('title')} />}</Field>
        <Field label="Message" error={errors.message}>{(p) => <Input {...p} value={form.message} maxLength={200} onChange={text('message')} />}</Field>
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Banner icon">
          <button type="button" role="radio" aria-checked={!form.icon} onClick={() => setForm({ ...form, icon: '' })} className={`rounded-md border px-2 py-1 text-xs ${!form.icon ? 'border-accent bg-accent/10' : 'border-border'}`}>No icon</button>
          {[...new Set([...(occasion ? [occasion.icon] : []), ...BANNER_ICONS])].map((i) => (
            <button key={i} type="button" role="radio" aria-checked={form.icon === i} aria-label={`Icon ${i}`} onClick={() => setForm({ ...form, icon: i })} className={`rounded-md border px-1.5 py-0.5 text-base ${form.icon === i ? 'border-accent bg-accent/10' : 'border-border'}`}>{i}</button>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {(['bgColor', 'fgColor'] as const).map((k) => (
            <Field key={k} label={k === 'bgColor' ? 'Banner colour' : 'Text colour'} error={errors[k]}>
              {(p) => (
                <div className="flex items-center gap-2">
                  <input type="color" aria-label={`Pick ${k === 'bgColor' ? 'banner' : 'text'} colour`} value={hex(form[k], '#1F3A93')} onChange={text(k)} className="h-9 w-12 cursor-pointer rounded-md border border-border bg-bg" />
                  <Input {...p} value={form[k]} onChange={text(k)} className="w-32" />
                </div>
              )}
            </Field>
          ))}
          <Field label="Starts" hint={occasion ? 'Empty: festival dates.' : undefined} error={errors.startsOn}>{(p) => <Input {...p} type="date" value={form.startsOn} onChange={text('startsOn')} />}</Field>
          <Field label="Ends" error={errors.endsOn}>{(p) => <Input {...p} type="date" value={form.endsOn} onChange={text('endsOn')} />}</Field>
          <Field label="Link" hint="Optional: where a click on the banner goes." error={errors.linkUrl}>{(p) => <Input {...p} value={form.linkUrl} placeholder="https://" onChange={text('linkUrl')} />}</Field>
          <Field label="Position">
            {(p) => <Select {...p} value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value as Form['position'] })}><option value="below">Below the signature</option><option value="above">Above the signature</option></Select>}
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => input.current?.click()}><ImageUp className="size-3.5" /> {imageSrc || file ? 'Change image' : 'Add an image or GIF'}</Button>
          {filePreview && <img src={filePreview} alt="Chosen banner image" className="max-h-16 max-w-60 rounded border border-border" />}
          {banner?.image && !file && (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => { const r = await removeBannerImageAction(banner.id); if (r.ok) { onSaved(r.message!); onClose(); } else setError(r.message); })}><Trash2 className="size-3.5" /> Remove image</Button>
          )}
          <span className="text-xs text-fg-subtle">PNG, JPEG or GIF up to 1 MB, about 480 by 100 pixels. Outlook 2013 and 2016 show a GIF&apos;s first frame; Outlook for Microsoft 365 plays it. With an image, the message is its alternative text.</span>
          <input ref={input} type="file" accept="image/png,image/jpeg,image/gif" className="sr-only" aria-label="Choose banner image" tabIndex={-1} onChange={(ev) => { const f = ev.target.files?.[0]; ev.target.value = ''; if (f) pick(f); }} />
        </div>
        <Checkbox label="Show this banner" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
        <SignaturePreview template="classic" data={preview} label="Banner preview" />
      </div>
    </Dialog>
  );
}
