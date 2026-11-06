'use client';
import { BANNER_ICONS, bannerWindow, type CompanyBanner, OCCASIONS, occasionWindow, type pickBanner } from '@crew/contracts';
import { Badge, Card, CardBody, CardHeader, Checkbox, Field, Input } from '@crew/ui';
import { Eye } from 'lucide-react';

export interface WishesDraft { showCompany: boolean; occasions: string[]; message: string; icon: string; from: string; to: string }

/** "6 Nov" or "6 Nov – 10 Nov 2027". */
export function dateRange(from: string, to: string) {
  const f = (d: string, year: boolean) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' });
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return from === to ? f(from, true) : `${f(from, !sameYear)} – ${f(to, true)}`;
}

/** Festival and celebration wishes: company banners, festivals the person picks, and their own message. */
export function WishesCard({ wishes, onChange, errors, today, banners, active, previewOccasion, onPreview }: {
  wishes: WishesDraft;
  onChange: (w: WishesDraft) => void;
  errors: Record<string, string>;
  today: string;
  banners: CompanyBanner[];
  active: ReturnType<typeof pickBanner>;
  previewOccasion: string | null;
  onPreview: (key: string | null) => void;
}) {
  const set = (patch: Partial<WishesDraft>) => onChange({ ...wishes, ...patch });
  const upcoming = banners
    .map((b) => ({ b, w: bannerWindow(b, today) }))
    .filter((x) => x.w && x.w.to >= today)
    .sort((p, q) => p.w!.from.localeCompare(q.w!.from));
  const covered = new Set(banners.filter((b) => b.occasionKey).map((b) => b.occasionKey));
  const library = OCCASIONS.map((o) => ({ o, w: occasionWindow(o, today) })).sort((p, q) => (p.w?.from ?? '9999').localeCompare(q.w?.from ?? '9999'));
  const nowLabel = !active ? 'No wish today' : active.source.kind === 'company' ? `Today: ${active.source.banner.title}` : active.source.kind === 'occasion' ? `Today: ${active.source.occasion.name}` : 'Today: your message';

  return (
    <Card aria-label="Festival and celebration wishes">
      <CardHeader
        title="Festival and celebration wishes"
        description="A banner under your signature for festivals, celebrations or your own message. It appears on its dates by itself, and one shows at a time."
        action={<Badge tone={active ? 'success' : 'neutral'}>{nowLabel}</Badge>}
      />
      <CardBody className="grid gap-5 text-[0.8125rem]">
        <div className="space-y-2">
          <Checkbox label="Show my company's banners" description="Company banners come first when they are on." checked={wishes.showCompany} onChange={(e) => set({ showCompany: e.target.checked })} />
          {upcoming.length > 0 && (
            <ul className="ml-6 space-y-1 text-xs text-fg-muted" aria-label="Company banners">
              {upcoming.map(({ b, w }) => (
                <li key={b.id}>{b.icon ? `${b.icon} ` : ''}<span className="font-medium text-fg">{b.title}</span>: {dateRange(w!.from, w!.to)}</li>
              ))}
            </ul>
          )}
        </div>

        <fieldset>
          <legend className="mb-1 text-[0.8125rem] font-medium text-fg">Festivals and days I want to wish people for</legend>
          <p className="mb-2 text-xs text-fg-subtle">Each shows a few days before and during the festival. Dates for moon-calendar festivals can differ by a day where you are.</p>
          <div className="grid max-h-80 gap-1 overflow-y-auto rounded-lg border border-border p-2 sm:grid-cols-2" role="group" aria-label="Festival library">
            {library.map(({ o, w }) => {
              const companyHasIt = wishes.showCompany && covered.has(o.key);
              return (
                <div key={o.key} className="flex items-start justify-between gap-2 rounded-md px-1.5 py-1 hover:bg-bg-subtle">
                  <Checkbox
                    label={<><span aria-hidden>{o.icon}</span> {o.name}</>}
                    description={`${o.region}${w ? ` · ${dateRange(w.from, w.to)}` : ''}${companyHasIt ? ' · your company already wishes this' : ''}`}
                    checked={wishes.occasions.includes(o.key)}
                    disabled={companyHasIt && !wishes.occasions.includes(o.key)}
                    onChange={(e) => set({ occasions: e.target.checked ? [...wishes.occasions, o.key] : wishes.occasions.filter((k) => k !== o.key) })}
                  />
                  <button
                    type="button"
                    aria-label={`Preview ${o.name}`}
                    aria-pressed={previewOccasion === o.key}
                    onClick={() => onPreview(previewOccasion === o.key ? null : o.key)}
                    className={`shrink-0 rounded p-1 ${previewOccasion === o.key ? 'text-accent' : 'text-fg-subtle hover:text-fg'}`}
                  ><Eye className="size-3.5" /></button>
                </div>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="grid gap-3">
          <legend className="mb-1 text-[0.8125rem] font-medium text-fg">My own message</legend>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Message icon">
            <button type="button" role="radio" aria-checked={!wishes.icon} onClick={() => set({ icon: '' })} className={`rounded-md border px-2 py-1 text-xs ${!wishes.icon ? 'border-accent bg-accent/10' : 'border-border'}`}>No icon</button>
            {BANNER_ICONS.map((i) => (
              <button key={i} type="button" role="radio" aria-checked={wishes.icon === i} aria-label={`Icon ${i}`} onClick={() => set({ icon: i })} className={`rounded-md border px-1.5 py-0.5 text-base ${wishes.icon === i ? 'border-accent bg-accent/10' : 'border-border'}`}>{i}</button>
            ))}
          </div>
          <Field label="Message" hint="For example a launch, an event, an award or when you are away. Leave empty for none." error={errors['wishes.message']}>
            {(p) => <Input {...p} value={wishes.message} maxLength={200} onChange={(e) => set({ message: e.target.value })} />}
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Show from" hint="Empty: from now." error={errors['wishes.from']}>{(p) => <Input {...p} type="date" value={wishes.from} onChange={(e) => set({ from: e.target.value })} />}</Field>
            <Field label="Show until" hint="Empty: until you remove it." error={errors['wishes.to']}>{(p) => <Input {...p} type="date" value={wishes.to} onChange={(e) => set({ to: e.target.value })} />}</Field>
          </div>
        </fieldset>
        <p className="text-xs text-fg-subtle">Computers set to update automatically switch banners within 30 minutes of the day changing. With manual updates, click &quot;Sync SampCrew signature&quot; on your desktop.</p>
      </CardBody>
    </Card>
  );
}
