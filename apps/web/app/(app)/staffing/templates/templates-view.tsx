'use client';
import type { BidTemplateInput } from '@crew/contracts';
import { Alert, Badge, Button, Card, Checkbox, Dialog, EmptyState, Field, Input, Textarea } from '@crew/ui';
import { FileStack, Pencil, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { archiveTemplateAction, saveTemplateAction } from '../actions';
import type { BidTemplate } from '../types';

export function TemplatesView({ templates }: { templates: BidTemplate[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<BidTemplate | 'new' | null>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-4">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div className="flex justify-end"><Button onClick={() => setEditing('new')}><Plus className="size-4" /> New template</Button></div>
      {templates.length ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {templates.map((t) => (
            <Card key={t.id} className="p-5">
              <div className="flex items-start gap-2">
                <h2 className="flex-1 text-sm font-semibold">{t.name}</h2>
                {t.isDefault && <Badge tone="info">Default</Badge>}
                <Button size="sm" variant="ghost" aria-label={`Edit ${t.name}`} onClick={() => setEditing(t)}><Pencil className="size-3.5" /></Button>
              </div>
              <p className="mt-1 text-xs text-fg-subtle">On-costs {t.onCostPct}% · overhead {t.overheadPct}% · target margin {t.targetMarginPct}% · valid {t.validityDays} days</p>
              <p className="mt-3 line-clamp-3 whitespace-pre-line text-sm text-fg-muted">{t.coverNote || 'No cover note.'}</p>
              {!t.isDefault && (
                <div className="mt-3 flex justify-end">
                  <Button size="sm" variant="ghost" loading={pending} onClick={() => start(async () => { const r = await archiveTemplateAction(t.id); setMsg(r.ok ? { tone: 'success', text: `${t.name} archived` } : { tone: 'danger', text: r.message }); router.refresh(); })}>Archive</Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      ) : <Card><EmptyState icon={<FileStack className="size-5" />} title="No templates yet" /></Card>}
      <TemplateDialog
        template={editing === 'new' ? null : editing}
        open={editing !== null}
        onClose={() => setEditing(null)}
        onSaved={(name) => { setMsg({ tone: 'success', text: `${name} saved` }); setEditing(null); router.refresh(); }}
      />
    </div>
  );
}

function TemplateDialog({ template, open, onClose, onSaved }: { template: BidTemplate | null; open: boolean; onClose: () => void; onSaved: (name: string) => void }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={template ? `Edit ${template.name}` : 'New proposal template'}
      description="Bids already made keep their own text; changes apply to new bids."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="template-form" loading={pending}>Save template</Button></>}
    >
      <form
        key={template?.id ?? 'new'}
        id="template-form"
        className="grid grid-cols-1 gap-4 sm:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const body: BidTemplateInput = {
            name: String(f.get('name') ?? '').trim(),
            coverNote: String(f.get('coverNote') ?? ''),
            terms: String(f.get('terms') ?? ''),
            validityDays: Number(f.get('validityDays') || 30),
            onCostPct: String(f.get('onCostPct') ?? '').trim(),
            overheadPct: String(f.get('overheadPct') ?? '').trim(),
            targetMarginPct: String(f.get('targetMarginPct') ?? '').trim(),
            isDefault: f.get('isDefault') === 'on',
          };
          setError(null);
          start(async () => {
            const r = await saveTemplateAction(template?.id ?? null, body);
            if (r.ok) onSaved(body.name); else { setError(r.message); setFe(r.fieldErrors ?? {}); }
          });
        }}
      >
        {error && <Alert tone="danger" className="sm:col-span-4">{error}</Alert>}
        <Field label="Name" required error={fe.name} className="sm:col-span-4">{(f) => <Input {...f} name="name" defaultValue={template?.name} required maxLength={80} />}</Field>
        <Field label="On-costs %" error={fe.onCostPct}>{(f) => <Input {...f} name="onCostPct" inputMode="decimal" defaultValue={template?.onCostPct ?? '13'} />}</Field>
        <Field label="Overhead %" error={fe.overheadPct}>{(f) => <Input {...f} name="overheadPct" inputMode="decimal" defaultValue={template?.overheadPct ?? '5'} />}</Field>
        <Field label="Target margin %" error={fe.targetMarginPct}>{(f) => <Input {...f} name="targetMarginPct" inputMode="decimal" defaultValue={template?.targetMarginPct ?? '18'} />}</Field>
        <Field label="Valid for (days)" error={fe.validityDays}>{(f) => <Input {...f} name="validityDays" type="number" min={1} max={180} defaultValue={template?.validityDays ?? 30} />}</Field>
        <Field label="Cover note" error={fe.coverNote} className="sm:col-span-4">{(f) => <Textarea {...f} name="coverNote" rows={4} defaultValue={template?.coverNote} maxLength={4000} />}</Field>
        <Field label="Terms" error={fe.terms} className="sm:col-span-4">{(f) => <Textarea {...f} name="terms" rows={5} defaultValue={template?.terms} maxLength={4000} />}</Field>
        <div className="sm:col-span-4"><Checkbox name="isDefault" defaultChecked={template?.isDefault} label="Default template" description="Quick Bid and new bids start from this one." /></div>
      </form>
    </Dialog>
  );
}
