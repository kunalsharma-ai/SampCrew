'use client';
import { SAMPLE_SIGNATURE, SIGNATURE_TEMPLATES, signatureSettingsInput, type SignatureSettingsInput, type SignatureTemplateKey, SOCIAL_NETWORKS, type SocialNetwork } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, EmptyState, Field, Input, Select, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { ImageUp, Trash2, Unplug } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { adminRevokeComputerAction, removeSignatureLogoAction, saveCompanySignatureAction, uploadSignatureLogoAction } from '../actions';
import { SignaturePreview } from '../preview';
import type { CompanySignature, SignatureAgent } from '../types';

export interface SignaturePerson {
  id: string; name: string; employeeCode: string | null; workEmail: string | null; template: SignatureTemplateKey | null; syncMode: string | null; updatedAt: string | null;
  computers: number; lastAppliedAt: string | null; lastError: string | null;
}

const SOCIAL_LABEL: Record<SocialNetwork, string> = { linkedin: 'LinkedIn', x: 'X', facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube' };
const LOGO_TYPES = ['image/png', 'image/jpeg'];
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const templateName = (k: string | null) => SIGNATURE_TEMPLATES.find((t) => t.key === k)?.name ?? null;

export function CompanySignatureView({ settings, people, agents, banners }: { settings: CompanySignature; people: SignaturePerson[]; agents: Array<SignatureAgent & { employeeId: string }>; banners: React.ReactNode }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [form, setForm] = useState({
    companyName: settings.companyName ?? '', website: settings.website ?? '', phone: settings.phone ?? '', address: settings.address ?? '', disclaimer: settings.disclaimer ?? '',
    brandColor: settings.brandColor, accentColor: settings.accentColor, defaultTemplate: settings.defaultTemplate, syncMode: settings.syncMode,
    allowEmployeeSyncChoice: settings.allowEmployeeSyncChoice, lockTemplate: settings.lockTemplate,
    social: Object.fromEntries(SOCIAL_NETWORKS.map((n) => [n, settings.social[n] ?? ''])) as Record<SocialNetwork, string>,
  });
  const text = (k: 'companyName' | 'website' | 'phone' | 'address' | 'brandColor' | 'accentColor') => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const hex = (v: string, fallback: string) => (/^#[0-9a-f]{6}$/i.test(v) ? v : fallback);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = signatureSettingsInput.safeParse(form);
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])));
      return;
    }
    setErrors({});
    start(async () => {
      const r = await saveCompanySignatureAction(parsed.data as SignatureSettingsInput);
      setMsg(r.ok ? { tone: 'success', text: r.message! } : { tone: 'danger', text: r.message });
      if (!r.ok && r.fieldErrors) setErrors(r.fieldErrors);
      router.refresh();
    });
  };

  const upload = (file: File) => {
    if (!LOGO_TYPES.includes(file.type)) return setMsg({ tone: 'danger', text: 'Use a PNG or JPEG logo. Outlook cannot show SVG or WebP in signatures.' });
    if (file.size > 1024 * 1024) return setMsg({ tone: 'danger', text: 'The logo can be up to 1 MB.' });
    const fd = new FormData();
    fd.set('file', file, file.name);
    start(async () => {
      const r = await uploadSignatureLogoAction(fd);
      setMsg(r.ok ? { tone: 'success', text: r.message! } : { tone: 'danger', text: r.message });
      router.refresh();
    });
  };

  const logoSrc = settings.logo ? `/signature-logo?v=${encodeURIComponent(new Date(settings.logo.updatedAt).getTime())}` : null;
  const preview = {
    ...SAMPLE_SIGNATURE, company: form.companyName || SAMPLE_SIGNATURE.company, website: form.website || SAMPLE_SIGNATURE.website, address: form.address || SAMPLE_SIGNATURE.address,
    disclaimer: form.disclaimer || null, logoSrc, logoWidth: settings.logo?.width ?? null, logoHeight: settings.logo?.height ?? null,
    brandColor: hex(form.brandColor, settings.brandColor), accentColor: hex(form.accentColor, settings.accentColor), font: 'Arial' as const, size: 'medium' as const,
  };
  const synced = people.filter((p) => p.lastAppliedAt).length;

  return (
    <div className="space-y-6">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,460px)]">
        <Card aria-label="Company details">
          <CardHeader title="Company details" description="Used in everyone's signature. Empty fields fall back to the workspace and legal entity details." />
          <CardBody>
            <form onSubmit={save} className="grid gap-4">
              <fieldset disabled={pending} className="grid gap-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Company name" error={errors.companyName}>{(p) => <Input {...p} value={form.companyName} onChange={text('companyName')} />}</Field>
                  <Field label="Website" error={errors.website}>{(p) => <Input {...p} value={form.website} placeholder="https://" onChange={text('website')} />}</Field>
                  <Field label="Office phone" hint="People can enter their own instead." error={errors.phone}>{(p) => <Input {...p} value={form.phone} onChange={text('phone')} />}</Field>
                  <Field label="Address" error={errors.address}>{(p) => <Input {...p} value={form.address} onChange={text('address')} />}</Field>
                  {(['brandColor', 'accentColor'] as const).map((k) => (
                    <Field key={k} label={k === 'brandColor' ? 'Main colour' : 'Accent colour'} error={errors[k]}>
                      {(p) => (
                        <div className="flex items-center gap-2">
                          <input type="color" aria-label={`Pick ${k === 'brandColor' ? 'main' : 'accent'} colour`} value={hex(form[k], settings[k])} onChange={text(k)} className="h-9 w-12 cursor-pointer rounded-md border border-border bg-bg" />
                          <Input {...p} value={form[k]} onChange={text(k)} className="w-32" />
                        </div>
                      )}
                    </Field>
                  ))}
                </div>
                <Field label="Disclaimer" hint="Added at the bottom of signatures. People can hide it unless you lock the design." error={errors.disclaimer}>
                  {(p) => <Textarea {...p} rows={3} value={form.disclaimer} onChange={(e) => setForm({ ...form, disclaimer: e.target.value })} />}
                </Field>
                <fieldset>
                  <legend className="mb-2 text-[0.8125rem] font-medium text-fg">Company social links</legend>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {SOCIAL_NETWORKS.map((n) => (
                      <Field key={n} label={SOCIAL_LABEL[n]} error={errors[`social.${n}`]}>
                        {(p) => <Input {...p} value={form.social[n]} placeholder="https://" onChange={(e) => setForm({ ...form, social: { ...form.social, [n]: e.target.value } })} />}
                      </Field>
                    ))}
                  </div>
                </fieldset>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Design people start with" hint="Everyone without a saved choice uses it.">
                    {(p) => <Select {...p} value={form.defaultTemplate} onChange={(e) => setForm({ ...form, defaultTemplate: e.target.value as SignatureTemplateKey })}>{SIGNATURE_TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</Select>}
                  </Field>
                  <Field label="Keep Outlook up to date">
                    {(p) => (
                      <Select {...p} value={form.syncMode} onChange={(e) => setForm({ ...form, syncMode: e.target.value as 'auto' | 'manual' })}>
                        <option value="auto">Automatically (every 30 minutes and at sign-in)</option>
                        <option value="manual">Manually (desktop shortcut)</option>
                      </Select>
                    )}
                  </Field>
                </div>
                <Checkbox label="Everyone uses this design" description="People can still change their own details and what is shown, but not the design." checked={form.lockTemplate} onChange={(e) => setForm({ ...form, lockTemplate: e.target.checked })} />
                <Checkbox label="People can choose automatic or manual sync for themselves" checked={form.allowEmployeeSyncChoice} onChange={(e) => setForm({ ...form, allowEmployeeSyncChoice: e.target.checked })} />
              </fieldset>
              <div><Button type="submit" loading={pending}>Save company settings</Button></div>
            </form>
          </CardBody>
        </Card>

        <div className="space-y-6">
          <Card aria-label="Logo">
            <CardHeader title="Signature logo" description="PNG or JPEG, up to 1 MB. A wide logo about 300 by 100 pixels looks sharpest." />
            <CardBody className="flex flex-wrap items-center gap-3">
              {logoSrc ? <img src={logoSrc} alt="Company signature logo" className="max-h-14 max-w-48 rounded border border-border bg-white p-1" /> : <span className="text-[0.8125rem] text-fg-muted">No logo yet.</span>}
              <Button size="sm" variant="secondary" loading={pending} onClick={() => input.current?.click()}><ImageUp className="size-3.5" /> {logoSrc ? 'Change logo' : 'Upload logo'}</Button>
              {logoSrc && <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => {
                const r = await removeSignatureLogoAction();
                setMsg(r.ok ? { tone: 'success', text: r.message! } : { tone: 'danger', text: r.message });
                router.refresh();
              })}><Trash2 className="size-3.5" /> Remove</Button>}
              <input ref={input} type="file" accept="image/png,image/jpeg" className="sr-only" aria-label="Choose signature logo" tabIndex={-1} onChange={(ev) => { const f = ev.target.files?.[0]; ev.target.value = ''; if (f) upload(f); }} />
            </CardBody>
          </Card>
          <Card aria-label="Company preview">
            <CardHeader title="Preview" description="The starting design with sample details. Each person sees their own." />
            <CardBody><SignaturePreview template={form.defaultTemplate} data={preview} label="Company signature preview" /></CardBody>
          </Card>
        </div>
      </div>

      {banners}

      <Card aria-label="Signatures across the company">
        <CardHeader title="Signatures across the company" description={`${synced} of ${people.length} people have the signature installed on at least one computer.`} />
        {people.length === 0 ? (
          <CardBody><EmptyState title="No employees yet" /></CardBody>
        ) : (
          <Table aria-label="People and their signatures">
            <THead><TR><TH>Person</TH><TH>Design</TH><TH>Sync</TH><TH>Computers</TH><TH>Last installed</TH></TR></THead>
            <TBody>
              {people.map((p) => {
                const mine = agents.filter((a) => a.employeeId === p.id);
                return (
                  <TR key={p.id}>
                    <TD><div className="font-medium">{p.name}</div><div className="text-xs text-fg-subtle">{[p.employeeCode, p.workEmail].filter(Boolean).join(' · ')}</div></TD>
                    <TD>{templateName(p.template) ?? <span className="text-fg-subtle">Company default</span>}</TD>
                    <TD>{p.syncMode ? (p.syncMode === 'auto' ? 'Automatic' : 'Manual') : <span className="text-fg-subtle">Company default</span>}</TD>
                    <TD>
                      {mine.length === 0 ? <span className="text-fg-subtle">None</span> : (
                        <ul className="space-y-1">
                          {mine.map((a) => (
                            <li key={a.id} className="flex items-center gap-2">
                              <span>{a.name}{a.computerName ? ` (${a.computerName})` : ''}</span>
                              {a.lastError ? <Badge tone="danger">Failed</Badge> : !a.lastAppliedAt ? <Badge tone="neutral">Waiting</Badge> : null}
                              <Button size="sm" variant="ghost" aria-label={`Disconnect ${a.name} for ${p.name}`} disabled={pending} onClick={() => start(async () => {
                                const r = await adminRevokeComputerAction(a.id);
                                setMsg(r.ok ? { tone: 'success', text: r.message! } : { tone: 'danger', text: r.message });
                                router.refresh();
                              })}><Unplug className="size-3.5" /></Button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {p.lastError && <div className="mt-1 text-xs text-danger">{p.lastError}</div>}
                    </TD>
                    <TD className="whitespace-nowrap">{when(p.lastAppliedAt) || <span className="text-fg-subtle">Never</span>}</TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
