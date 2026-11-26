'use client';
import { Alert, Badge, Button, Card, CardHeader, Checkbox, Field, Input, Textarea } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { previewEmailTemplateAction, resetEmailTemplateAction, saveEmailTemplateAction, testEmailTemplateAction } from './actions';
import type { EmailTemplates } from './types';

export function TemplatesEditor({ data }: { data: EmailTemplates }) {
  const [key, setKey] = useState(data.templates[0]!.key);
  const t = data.templates.find((x) => x.key === key)!;
  return (
    <div className="grid gap-5" data-testid="email-templates">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Kinds of email">
        {data.templates.map((x) => (
          <button key={x.key} type="button" role="tab" aria-selected={x.key === key} onClick={() => setKey(x.key)} data-testid={`email-template-tab-${x.key}`}
            className={`rounded-full border px-3 py-1.5 text-sm ${x.key === key ? 'border-accent bg-accent text-accent-fg' : 'border-border hover:bg-bg-subtle'}`}>
            {x.name}{x.active && <span className="ml-1.5" aria-label="in use">●</span>}
          </button>
        ))}
      </div>
      <Editor key={t.key} t={t} data={data} />
    </div>
  );
}

function Editor({ t, data }: { t: EmailTemplates['templates'][number]; data: EmailTemplates }) {
  const router = useRouter();
  const file = useRef<HTMLInputElement>(null);
  const [html, setHtml] = useState(t.html ?? '');
  const [subject, setSubject] = useState(t.subject ?? '');
  const [active, setActive] = useState(t.saved ? t.active : true);
  const [source, setSource] = useState<string | undefined>(t.sourceFileName ?? undefined);
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [sendTo, setSendTo] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const hasContent = /\{\{\s*content\s*\}\}/.test(html);

  // The preview follows the HTML as it is typed, filled in with a sample message.
  useEffect(() => {
    if (!html.trim()) { setPreview(null); return; }
    const id = setTimeout(() => void previewEmailTemplateAction(html, subject).then((r) => { if (r.ok && r.data) setPreview(r.data); }), 400);
    return () => clearTimeout(id);
  }, [html, subject]);

  const importFile = (f: File | undefined) => {
    setMsg(null);
    if (!f) return;
    if (!/\.html?$/i.test(f.name) || f.size > 200_000) return setMsg({ ok: false, text: 'Choose an .html file up to 200 KB.' });
    void f.text().then((text) => {
      setHtml(text);
      setSource(f.name);
      if (!/\{\{\s*content\s*\}\}/.test(text)) setMsg({ ok: false, text: `${f.name} is loaded, but it has no {{content}}. Add {{content}} where the message should go, then save.` });
    });
  };
  const done = (r: { ok: boolean; message?: string }) => { setMsg({ ok: r.ok, text: r.message ?? (r.ok ? 'Done.' : 'That did not work.') }); if (r.ok) router.refresh(); };

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader
          title={t.name}
          description={t.description}
          action={t.saved ? <Badge tone={t.active ? 'success' : 'neutral'}>{t.active ? 'In use' : 'Off'}</Badge> : <Badge>Standard SampCrew email</Badge>}
        />
        <div className="grid gap-3 px-5 pb-5">
          {msg && <Alert tone={msg.ok ? 'success' : 'danger'}>{msg.text}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => file.current?.click()} data-testid="email-template-import">Import HTML file</Button>
            <input ref={file} type="file" accept=".html,.htm,text/html" className="sr-only" aria-label="Email template file" onChange={(e) => { importFile(e.target.files?.[0]); e.target.value = ''; }} data-testid="email-template-file" />
            <Button size="sm" variant="ghost" onClick={() => { setHtml(data.defaultHtml); setSource(undefined); }}>Start from the SampCrew design</Button>
          </div>
          <Field label="Subject line (optional)" hint="Leave empty to keep each email's own subject. {{subject}} is that subject, so “{{company_name}}: {{subject}}” adds your name in front.">
            {(p) => <Input {...p} maxLength={300} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="{{subject}}" />}
          </Field>
          <Field label="HTML" error={html && !hasContent ? 'Put {{content}} where the message should go' : undefined} hint={source ? `Imported from ${source}` : undefined}>
            {(p) => <Textarea {...p} rows={16} className="font-mono text-xs" value={html} onChange={(e) => setHtml(e.target.value)} spellCheck={false} data-testid="email-template-html" />}
          </Field>
          <div className="rounded-lg bg-bg-subtle p-3 text-xs">
            <p className="mb-1 font-medium">Placeholders</p>
            <ul className="grid gap-0.5">{data.placeholders.map((p) => <li key={p.key}><code>{`{{${p.key}}}`}</code> {p.description}</li>)}</ul>
          </div>
          <Checkbox label="Use this template" description="Off keeps it saved without using it." checked={active} onChange={(e) => setActive(e.target.checked)} />
          <div className="flex flex-wrap gap-2">
            <Button loading={pending} disabled={!hasContent} onClick={() => start(async () => done(await saveEmailTemplateAction(t.key, { html, active, ...(subject.trim() ? { subject: subject.trim() } : {}), ...(source ? { sourceFileName: source } : {}) })))} data-testid="email-template-save">Save template</Button>
            {t.saved && t.active && <Button variant="secondary" loading={pending} onClick={() => start(async () => done(await resetEmailTemplateAction(t.key)))}>Back to standard email</Button>}
          </div>
          {t.updatedAt && <p className="text-xs text-fg-subtle">Version {t.version}, changed {new Date(t.updatedAt).toLocaleString()}{t.updatedBy ? ` by ${t.updatedBy}` : ''}.</p>}
        </div>
      </Card>
      <Card>
        <CardHeader title="Preview" description={preview ? `Subject: ${preview.subject}` : 'Import or write a template to see it with a sample message.'} />
        <div className="grid gap-3 px-5 pb-5">
          {preview ? (
            // The template is shown in a sandbox: nothing in it can run or reach this page.
            <iframe title="Email preview" sandbox="" srcDoc={preview.html} className="h-[32rem] w-full rounded-lg border border-border bg-white" data-testid="email-template-preview" />
          ) : <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-border text-sm text-fg-muted">No preview yet</div>}
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Send a test to" className="min-w-56 flex-1">{(p) => <Input {...p} type="email" value={sendTo} onChange={(e) => setSendTo(e.target.value)} placeholder="you@yourcompany.com" />}</Field>
            <Button variant="secondary" loading={pending} disabled={!hasContent || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sendTo)} onClick={() => start(async () => { const r = await testEmailTemplateAction(t.key, sendTo, html, subject.trim() || undefined); setMsg({ ok: r.ok, text: r.ok ? r.data?.message ?? 'Sent.' : r.message }); })}>Send test</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
