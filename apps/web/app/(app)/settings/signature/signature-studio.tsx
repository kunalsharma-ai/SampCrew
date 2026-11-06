'use client';
import {
  composeSignatureData, SIGNATURE_FONTS, SIGNATURE_SIZES, SIGNATURE_TEMPLATES, type SignatureOptions, signatureOptionsInput, type SignatureSyncMode,
  type SignatureTemplateKey, SOCIAL_NETWORKS, type SocialNetwork,
} from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, Field, Input, Select } from '@crew/ui';
import { Check, Download, Monitor, RefreshCw, Unplug } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { addComputerAction, requestSyncAction, revokeComputerAction, saveSignatureAction } from './actions';
import { SignaturePreview } from './preview';
import { type MySignature, previewImages, type SignatureAgent } from './types';

const SHOW: Array<{ key: keyof SignatureOptions['show']; label: string }> = [
  { key: 'photo', label: 'My photo' }, { key: 'logo', label: 'Company logo' }, { key: 'department', label: 'Department' }, { key: 'phone', label: 'Office phone' },
  { key: 'mobile', label: 'Mobile' }, { key: 'email', label: 'Email' }, { key: 'website', label: 'Website' }, { key: 'address', label: 'Address' },
  { key: 'social', label: 'Social links' }, { key: 'disclaimer', label: 'Company disclaimer' },
];
const SOCIAL_LABEL: Record<SocialNetwork, string> = { linkedin: 'LinkedIn', x: 'X', facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube' };
const TEXT_FIELDS = ['jobTitle', 'phone', 'mobile', 'pronouns', 'signOff', 'tagline', 'ctaLabel', 'ctaUrl', 'brandColor', 'accentColor'] as const;
type TextField = (typeof TEXT_FIELDS)[number];
type Draft = Record<TextField, string> & { font: SignatureOptions['font']; size: SignatureOptions['size']; show: SignatureOptions['show']; social: Record<SocialNetwork, string> };

function toDraft(o: SignatureOptions): Draft {
  return {
    ...(Object.fromEntries(TEXT_FIELDS.map((k) => [k, (o[k] as string | undefined) ?? ''])) as Record<TextField, string>),
    font: o.font, size: o.size, show: { ...o.show },
    social: Object.fromEntries(SOCIAL_NETWORKS.map((n) => [n, o.social?.[n] ?? ''])) as Record<SocialNetwork, string>,
  };
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null);

export function SignatureStudio({ initial }: { initial: MySignature }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const locked = initial.company.lockTemplate;
  const [template, setTemplate] = useState<SignatureTemplateKey>(initial.template);
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial.options));
  const [syncChoice, setSyncChoice] = useState<SignatureSyncMode | null>(initial.ownSyncMode);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger' | 'info'; text: string } | null>(null);
  const [computerName, setComputerName] = useState('My Windows PC');
  const [justDownloaded, setJustDownloaded] = useState(false);

  // The preview uses the last valid choices, so a half-typed colour or link never breaks it.
  const parsed = signatureOptionsInput.safeParse(draft);
  const errors = parsed.success ? {} : Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message]));
  const lastGood = useRef<SignatureOptions>(initial.options);
  if (parsed.success) lastGood.current = parsed.data;
  const options = lastGood.current;

  const data = { ...composeSignatureData(initial.base, options), ...previewImages(initial, options.show) };
  const savedKey = JSON.stringify({ t: initial.template, o: initial.options, s: initial.ownSyncMode });
  const dirty = !initial.saved || JSON.stringify({ t: template, o: options, s: syncChoice }) !== savedKey;
  const effectiveMode = initial.company.allowEmployeeSyncChoice ? (syncChoice ?? initial.company.syncMode) : initial.company.syncMode;

  const set = (k: TextField) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [k]: e.target.value });

  const save = async () => {
    if (!parsed.success) {
      setMsg({ tone: 'danger', text: 'Fix the highlighted fields first.' });
      return false;
    }
    const r = await saveSignatureAction({ template, options: parsed.data, syncMode: initial.company.allowEmployeeSyncChoice ? syncChoice : null });
    setMsg(r.ok ? { tone: 'success', text: r.message! } : { tone: 'danger', text: r.message });
    return r.ok;
  };

  const download = () => start(async () => {
    if (dirty && !(await save())) return;
    const r = await addComputerAction(computerName.trim() || 'My Windows PC');
    if (!r.ok) return setMsg({ tone: 'danger', text: r.message });
    const blob = new Blob([r.data!.installer], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = r.data!.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    setJustDownloaded(true);
    setMsg({ tone: 'success', text: `The setup file for "${computerName.trim() || 'My Windows PC'}" is downloaded. Open it on that computer to finish.` });
    router.refresh();
  });

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,520px)]">
      <div className="min-w-0 space-y-6">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}

        <Card aria-label="Designs">
          <CardHeader
            title="Choose a design"
            description={locked ? 'Your company uses one design for everyone. You can still change your own details and what is shown.' : `${SIGNATURE_TEMPLATES.length} designs, shown with your own details. Pick one, then customise it.`}
          />
          <CardBody>
            {locked ? (
              <p className="text-[0.8125rem] text-fg-muted">Design: <strong className="text-fg">{SIGNATURE_TEMPLATES.find((t) => t.key === template)?.name}</strong></p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Signature designs">
                {SIGNATURE_TEMPLATES.map((t) => {
                  const selected = t.key === template;
                  return (
                    <button
                      key={t.key}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={t.name}
                      data-testid={`design-${t.key}`}
                      onClick={() => setTemplate(t.key)}
                      className={`group flex flex-col gap-2 rounded-xl border p-2.5 text-left transition-colors ${selected ? 'border-accent ring-2 ring-accent/30' : 'border-border hover:border-border-strong'}`}
                    >
                      <div className="pointer-events-none h-36 overflow-hidden">
                        <SignaturePreview template={t.key} data={{ ...data, size: 'small' }} label={`${t.name} preview`} className="origin-top-left scale-[0.8] w-[125%]" />
                      </div>
                      <div className="flex items-start justify-between gap-2 px-1">
                        <div>
                          <div className="text-[0.8125rem] font-medium text-fg">{t.name}</div>
                          <div className="text-xs text-fg-subtle">{t.description}</div>
                        </div>
                        {selected && <Check className="size-4 shrink-0 text-accent" aria-hidden />}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </CardBody>
        </Card>

        <Card aria-label="Customise">
          <CardHeader title="Customise" description="Leave a field empty to use what HR has on record. Company details (name, website, address, logo, disclaimer) are set by your admins." />
          <CardBody className="grid gap-5">
            <div className="grid gap-4 sm:grid-cols-2">
              {(['brandColor', 'accentColor'] as const).map((k) => (
                <Field key={k} label={k === 'brandColor' ? 'Main colour' : 'Accent colour'} hint={`Empty uses the company colour (${initial.company[k]}).`} error={errors[k]}>
                  {(p) => (
                    <div className="flex items-center gap-2">
                      <input type="color" aria-label={`Pick ${k === 'brandColor' ? 'main' : 'accent'} colour`} value={/^#[0-9a-f]{6}$/i.test(draft[k]) ? draft[k] : initial.company[k]} onChange={set(k)} className="h-9 w-12 cursor-pointer rounded-md border border-border bg-bg" />
                      <Input {...p} value={draft[k]} placeholder={initial.company[k]} onChange={set(k)} className="w-32" />
                    </div>
                  )}
                </Field>
              ))}
              <Field label="Font">
                {(p) => <Select {...p} value={draft.font} onChange={(e) => setDraft({ ...draft, font: e.target.value as Draft['font'] })}>{SIGNATURE_FONTS.map((f) => <option key={f}>{f}</option>)}</Select>}
              </Field>
              <Field label="Text size">
                {(p) => <Select {...p} value={draft.size} onChange={(e) => setDraft({ ...draft, size: e.target.value as Draft['size'] })}>{SIGNATURE_SIZES.map((s) => <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>)}</Select>}
              </Field>
            </div>

            <fieldset>
              <legend className="mb-2 text-[0.8125rem] font-medium text-fg">Show in my signature</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {SHOW.map((s) => (
                  <Checkbox key={s.key} label={s.label} checked={draft.show[s.key]} onChange={(e) => setDraft({ ...draft, show: { ...draft.show, [s.key]: e.target.checked } })} />
                ))}
              </div>
              {initial.photoNotForOutlook && draft.show.photo && <p className="mt-2 text-xs text-warning">Your photo is a WebP image, which Outlook cannot show. Upload a PNG or JPEG photo in Appearance to include it.</p>}
              {!initial.photoUpdatedAt && draft.show.photo && <p className="mt-2 text-xs text-fg-subtle">You have no photo yet. Add one in Settings, Appearance.</p>}
              {!initial.canUseLogo && draft.show.logo && <p className="mt-2 text-xs text-fg-subtle">Your company has not added a signature logo yet.</p>}
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Job title" hint={initial.base.designation ? `Empty uses "${initial.base.designation}".` : undefined} error={errors.jobTitle}>{(p) => <Input {...p} value={draft.jobTitle} placeholder={initial.base.designation ?? ''} onChange={set('jobTitle')} />}</Field>
              <Field label="Pronouns" hint="Optional, e.g. she/her" error={errors.pronouns}>{(p) => <Input {...p} value={draft.pronouns} onChange={set('pronouns')} />}</Field>
              <Field label="Office phone" hint={initial.base.phone ? `Empty uses ${initial.base.phone}.` : undefined} error={errors.phone}>{(p) => <Input {...p} value={draft.phone} placeholder={initial.base.phone ?? ''} onChange={set('phone')} />}</Field>
              <Field label="Mobile" hint={initial.base.mobile ? `Empty uses ${initial.base.mobile}.` : undefined} error={errors.mobile}>{(p) => <Input {...p} value={draft.mobile} placeholder={initial.base.mobile ?? ''} onChange={set('mobile')} />}</Field>
              <Field label="Tagline" hint="A short line under your details." error={errors.tagline} className="sm:col-span-2">{(p) => <Input {...p} value={draft.tagline} onChange={set('tagline')} />}</Field>
              {template === 'warm' && <Field label="Sign-off" hint='Empty uses "Warm regards,".' error={errors.signOff}>{(p) => <Input {...p} value={draft.signOff} onChange={set('signOff')} />}</Field>}
              {template === 'call-to-action' && (
                <>
                  <Field label="Button text" hint='Empty uses "Book a meeting".' error={errors.ctaLabel}>{(p) => <Input {...p} value={draft.ctaLabel} onChange={set('ctaLabel')} />}</Field>
                  <Field label="Button link" error={errors.ctaUrl}>{(p) => <Input {...p} value={draft.ctaUrl} placeholder="https://" onChange={set('ctaUrl')} />}</Field>
                </>
              )}
            </div>

            <fieldset>
              <legend className="mb-2 text-[0.8125rem] font-medium text-fg">My social links</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                {SOCIAL_NETWORKS.map((n) => (
                  <Field key={n} label={SOCIAL_LABEL[n]} hint={initial.base.social[n] ? 'Empty uses the company link.' : undefined} error={errors[`social.${n}`]}>
                    {(p) => <Input {...p} value={draft.social[n]} placeholder={initial.base.social[n] ?? 'https://'} onChange={(e) => setDraft({ ...draft, social: { ...draft.social, [n]: e.target.value } })} />}
                  </Field>
                ))}
              </div>
            </fieldset>
          </CardBody>
        </Card>
      </div>

      <div className="min-w-0 space-y-6 xl:sticky xl:top-4 xl:self-start">
        <Card aria-label="Preview">
          <CardHeader title="Preview" description="Exactly what Outlook will show under your messages." action={dirty ? <Badge tone="warning">Not saved</Badge> : <Badge tone="success">Saved</Badge>} />
          <CardBody className="space-y-4">
            <SignaturePreview template={template} data={data} label="Your signature" />
            {initial.company.allowEmployeeSyncChoice ? (
              <fieldset>
                <legend className="mb-2 text-[0.8125rem] font-medium text-fg">Keep Outlook up to date</legend>
                <div className="grid gap-2 text-[0.8125rem]">
                  {([
                    [null, `Company default (${initial.company.syncMode === 'auto' ? 'automatically' : 'when I choose'})`],
                    ['auto', 'Automatically: every 30 minutes and when I sign in to Windows'],
                    ['manual', 'Only when I click "Sync SampCrew signature" on my desktop'],
                  ] as Array<[SignatureSyncMode | null, string]>).map(([v, label]) => (
                    <label key={String(v)} className="flex items-start gap-2"><input type="radio" name="syncMode" checked={syncChoice === v} onChange={() => setSyncChoice(v)} className="mt-0.5" /> {label}</label>
                  ))}
                </div>
              </fieldset>
            ) : (
              <p className="text-xs text-fg-subtle">Your company keeps signatures up to date {initial.company.syncMode === 'auto' ? 'automatically, every 30 minutes' : 'when you click "Sync SampCrew signature" on your desktop'}.</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button loading={pending} disabled={!dirty} onClick={() => start(async () => { if (await save()) router.refresh(); })}>Save signature</Button>
              {initial.agents.length > 0 && (
                <Button variant="secondary" disabled={pending || dirty} onClick={() => start(async () => {
                  const r = await requestSyncAction();
                  setMsg(r.ok ? { tone: 'success', text: effectiveMode === 'auto' ? `${r.message} That is within 30 minutes; click "Sync SampCrew signature" on the desktop to update now.` : 'Click "Sync SampCrew signature" on your desktop to update Outlook now.' } : { tone: 'danger', text: r.message });
                  router.refresh();
                })}><RefreshCw className="size-3.5" /> Sync my computers</Button>
              )}
            </div>
          </CardBody>
        </Card>

        <Card aria-label="Your computers">
          <CardHeader title="Outlook on your computers" description="For Outlook 2013, 2016, 2019, 2021 and Microsoft 365 on Windows. Nothing needs administrator rights." />
          <CardBody className="space-y-4 text-[0.8125rem]">
            {initial.agents.length > 0 && (
              <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Connected computers">
                {initial.agents.map((a) => <AgentRow key={a.id} agent={a} pending={pending} onRevoke={() => start(async () => {
                  const r = await revokeComputerAction(a.id);
                  setMsg(r.ok ? { tone: 'success', text: r.message! } : { tone: 'danger', text: r.message });
                  router.refresh();
                })} />)}
              </ul>
            )}
            <div className="space-y-2">
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Name this computer" className="min-w-48 flex-1">{(p) => <Input {...p} value={computerName} maxLength={80} onChange={(e) => setComputerName(e.target.value)} />}</Field>
                <Button onClick={download} loading={pending} disabled={!parsed.success}><Download className="size-3.5" /> {dirty ? 'Save and download setup file' : 'Download setup file'}</Button>
              </div>
              <ol className="list-decimal space-y-1 pl-5 text-fg-muted">
                <li>Download the setup file on the Windows computer where you use Outlook (or copy it there).</li>
                <li>Double-click <span className="font-mono text-xs">SampCrew-Outlook-Signature-Setup.cmd</span>. If Windows shows &quot;Windows protected your PC&quot;, click More info, then Run anyway.</li>
                <li>A message confirms the signature is in Outlook. Start a new email to see it.</li>
              </ol>
              <p className="text-xs text-fg-subtle">Each setup file works for one computer and one Windows user. Keep it private: it lets that computer receive your signature. You can disconnect a computer here at any time.</p>
              {justDownloaded && <p className="text-xs text-fg-subtle">The computer appears as connected once the setup file has run.</p>}
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function AgentRow({ agent: a, pending, onRevoke }: { agent: SignatureAgent; pending: boolean; onRevoke: () => void }) {
  const status = a.lastError
    ? <Badge tone="danger">Last sync failed</Badge>
    : !a.lastAppliedAt ? <Badge tone="neutral">Waiting for setup</Badge>
      : a.upToDate ? <Badge tone="success">Up to date</Badge> : <Badge tone="warning">Update pending</Badge>;
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 p-3" data-testid="computer-row">
      <div className="flex min-w-0 items-start gap-2.5">
        <Monitor className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 font-medium text-fg">{a.name} {status}</div>
          <div className="text-xs text-fg-subtle">
            {a.computerName ? `${a.computerName} · ` : ''}
            {a.outlookVersions?.length ? `Outlook ${a.outlookVersions.join(', ')} · ` : ''}
            {a.lastAppliedAt ? `Signature installed ${when(a.lastAppliedAt)}` : `Set up ${when(a.createdAt)}`}
            {a.lastSeenAt ? ` · Last check ${when(a.lastSeenAt)}` : ''}
          </div>
          {a.lastError && <div className="mt-1 text-xs text-danger">{a.lastError}</div>}
        </div>
      </div>
      <Button size="sm" variant="ghost" disabled={pending} onClick={onRevoke}><Unplug className="size-3.5" /> Disconnect</Button>
    </li>
  );
}
