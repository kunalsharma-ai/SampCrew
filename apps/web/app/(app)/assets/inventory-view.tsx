'use client';
import { ASSET_CONDITION_LABEL, ASSET_CONDITIONS, ASSET_STATUS_LABEL, ASSET_STATUSES } from '@crew/contracts';
import { Alert, Badge, Button, buttonClass, Card, CardBody, DatePicker, Dialog, EmptyState, Field, Input, Select, Stat, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { FileSpreadsheet, Laptop, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { createAssetAction } from './actions';
import { day, STATUS_TONE } from './labels';
import type { AssetList, Category } from './types';

type Filters = { status: string; categoryId: string; q: string };

export function InventoryView({ list, categories, filters, currency, canManage }: { list: AssetList; categories: Category[]; filters: Filters; currency: string; canManage: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState(filters.q);
  const [adding, setAdding] = useState(false);
  const go = (next: Partial<Filters>) => {
    const p = new URLSearchParams({ ...filters, ...next });
    for (const [k, v] of [...p.entries()]) if (!v) p.delete(k);
    router.push(`/assets${p.size ? `?${p}` : ''}`);
  };
  const n = (s: string) => list.counts[s] ?? 0;
  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Available" value={n('available')} />
        <Stat label="Assigned" value={n('assigned')} hint={`${list.items.filter((a) => a.holder && !a.holder.acknowledged).length} not acknowledged yet`} />
        <Stat label="Under maintenance" value={n('under_maintenance')} />
        <Stat label="Damaged or lost" value={n('damaged') + n('lost')} />
      </div>
      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Status" className="w-44">
            {(p) => <Select {...p} value={filters.status} onChange={(e) => go({ status: e.target.value })}><option value="">Any status</option>{ASSET_STATUSES.map((s) => <option key={s} value={s}>{ASSET_STATUS_LABEL[s]}</option>)}</Select>}
          </Field>
          <Field label="Category" className="w-48">
            {(p) => <Select {...p} value={filters.categoryId} onChange={(e) => go({ categoryId: e.target.value })}><option value="">All categories</option>{categories.filter((c) => !c.archived).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}
          </Field>
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); go({ q }); }}>
            <Field label="Search">{(p) => <Input {...p} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Code, name, serial, brand" />}</Field>
            <Button type="submit" variant="secondary" aria-label="Search assets"><Search className="size-3.5" aria-hidden /></Button>
          </form>
          <div className="ml-auto flex flex-wrap gap-2">
            {canManage && <Link className={buttonClass('secondary')} href="/assets/categories">Categories</Link>}
            {list.canExport && <Link className={buttonClass('secondary')} href="/assets/reports"><FileSpreadsheet className="size-3.5" aria-hidden /> Reports</Link>}
            {list.canCreate && <Button onClick={() => setAdding(true)}><Plus className="size-4" aria-hidden /> Register asset</Button>}
          </div>
        </CardBody>
        {list.items.length ? (
          <Table aria-label="Assets">
            <THead><tr><TH>Asset</TH><TH>Category</TH><TH>Serial</TH><TH>Status</TH><TH>Held by</TH><TH>Warranty</TH></tr></THead>
            <TBody>
              {list.items.map((a) => (
                <TR key={a.id}>
                  <TD><Link className="font-medium text-accent hover:underline" href={`/assets/${a.id}`}><span className="font-mono">{a.assetCode}</span> {a.name}</Link><div className="text-xs text-fg-muted">{[a.brand, a.model, a.location].filter(Boolean).join(' · ')}</div></TD>
                  <TD className="text-fg-muted">{a.category}</TD>
                  <TD className="font-mono text-xs">{a.serialNumber ?? '—'}</TD>
                  <TD><Badge tone={STATUS_TONE[a.status]}>{ASSET_STATUS_LABEL[a.status as keyof typeof ASSET_STATUS_LABEL]}</Badge></TD>
                  <TD>{a.holder ? <>{a.holder.name}<div className="text-xs text-fg-muted">since {day(a.holder.since)}{a.holder.acknowledged ? ' · acknowledged' : ' · not acknowledged'}</div></> : <span className="text-fg-muted">—</span>}</TD>
                  <TD className={a.warrantyExpired ? 'text-fg-muted line-through' : ''}>{day(a.warrantyExpiry) || '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <CardBody><EmptyState icon={<Laptop className="size-5" />} title="No assets" description={list.canCreate ? 'Register the company property you hand to people.' : 'No assets match these filters.'} /></CardBody>}
      </Card>
      {adding && <AssetDialog categories={categories.filter((c) => !c.archived)} currency={currency} onClose={() => setAdding(false)} onSaved={(id) => router.push(`/assets/${id}`)} />}
    </div>
  );
}

export function AssetDialog({ categories, currency, onClose, onSaved, asset, save }: {
  categories: Category[]; currency: string; onClose: () => void; onSaved: (id: string) => void;
  asset?: Partial<Record<string, string | null>> & { id?: string }; save?: (body: Record<string, unknown>) => Promise<{ ok: boolean; message?: string; fieldErrors?: Record<string, string> }>;
}) {
  const [purchaseDate, setPurchaseDate] = useState(asset?.purchaseDate ?? '');
  const [warrantyExpiry, setWarrantyExpiry] = useState(asset?.warrantyExpiry ?? '');
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const editing = Boolean(asset?.id);
  return (
    <Dialog open onClose={onClose} size="lg" title={editing ? 'Edit asset' : 'Register an asset'} description={editing ? undefined : 'Leave the asset ID empty to number it in its category (LAP-0001, LAP-0002 ...).'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="asset-form" loading={pending}>{editing ? 'Save' : 'Register asset'}</Button></>}>
      <form id="asset-form" className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const v = (k: string) => String(f.get(k) ?? '').trim();
        const body: Record<string, unknown> = {
          name: v('name'), categoryId: v('categoryId'), brand: v('brand'), model: v('model'), serialNumber: v('serialNumber'), vendor: v('vendor'), condition: v('condition'),
          location: v('location'), description: v('description'), remarks: v('remarks'), currency,
          ...(editing ? { purchaseDate: purchaseDate || null, warrantyExpiry: warrantyExpiry || null, purchasePrice: v('purchasePrice') || null, ...(v('assetCode') ? { assetCode: v('assetCode') } : {}) }
            : { purchaseDate, warrantyExpiry, purchasePrice: v('purchasePrice'), assetCode: v('assetCode') }),
        };
        setError(null);
        start(async () => {
          const r = save ? await save(body) : await createAssetAction(body);
          if (r.ok) onSaved((r as { data?: { id: string } }).data?.id ?? asset?.id ?? ''); else { setError(r.message ?? 'Could not save'); setFe(r.fieldErrors ?? {}); }
        });
      }}>
        {error && <div className="sm:col-span-2"><Alert tone="danger">{error}</Alert></div>}
        <Field label="Asset name" required error={fe.name}>{(p) => <Input {...p} name="name" required minLength={2} maxLength={160} defaultValue={asset?.name ?? ''} placeholder="MacBook Air 13" />}</Field>
        <Field label="Category" required error={fe.categoryId}>{(p) => <Select {...p} name="categoryId" required defaultValue={asset?.categoryId ?? ''}><option value="">Choose…</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}</Select>}</Field>
        <Field label="Asset ID" error={fe.assetCode}>{(p) => <Input {...p} name="assetCode" maxLength={40} defaultValue={asset?.assetCode ?? ''} placeholder="Numbered for you" />}</Field>
        <Field label="Serial number" error={fe.serialNumber}>{(p) => <Input {...p} name="serialNumber" maxLength={120} defaultValue={asset?.serialNumber ?? ''} />}</Field>
        <Field label="Brand" error={fe.brand}>{(p) => <Input {...p} name="brand" maxLength={80} defaultValue={asset?.brand ?? ''} />}</Field>
        <Field label="Model" error={fe.model}>{(p) => <Input {...p} name="model" maxLength={120} defaultValue={asset?.model ?? ''} />}</Field>
        <Field label="Purchase date" error={fe.purchaseDate}>{(p) => <DatePicker {...p} value={purchaseDate} onChange={setPurchaseDate} />}</Field>
        <Field label={`Purchase price (${currency})`} error={fe.purchasePrice}>{(p) => <Input {...p} name="purchasePrice" inputMode="decimal" defaultValue={asset?.purchasePrice ?? ''} placeholder="54999" />}</Field>
        <Field label="Vendor" error={fe.vendor}>{(p) => <Input {...p} name="vendor" maxLength={160} defaultValue={asset?.vendor ?? ''} />}</Field>
        <Field label="Warranty until" error={fe.warrantyExpiry}>{(p) => <DatePicker {...p} value={warrantyExpiry} onChange={setWarrantyExpiry} />}</Field>
        <Field label="Condition" error={fe.condition}>{(p) => <Select {...p} name="condition" defaultValue={asset?.condition ?? 'new'}>{ASSET_CONDITIONS.map((c) => <option key={c} value={c}>{ASSET_CONDITION_LABEL[c]}</option>)}</Select>}</Field>
        <Field label="Location" error={fe.location}>{(p) => <Input {...p} name="location" maxLength={160} defaultValue={asset?.location ?? ''} placeholder="Gurugram office, IT store" />}</Field>
        <Field label="Description" className="sm:col-span-2" error={fe.description}>{(p) => <Textarea {...p} name="description" rows={2} maxLength={2000} defaultValue={asset?.description ?? ''} />}</Field>
        <Field label="Remarks" className="sm:col-span-2" error={fe.remarks}>{(p) => <Textarea {...p} name="remarks" rows={2} maxLength={2000} defaultValue={asset?.remarks ?? ''} />}</Field>
      </form>
    </Dialog>
  );
}
