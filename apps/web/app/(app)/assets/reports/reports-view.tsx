'use client';
import { ASSET_REPORT_LABEL, ASSET_REPORTS } from '@crew/contracts';
import { buttonClass, Card, CardBody, CardHeader, DatePicker, Field, Select } from '@crew/ui';
import { FileSpreadsheet, FileText } from 'lucide-react';
import { useState } from 'react';
import type { Category } from '../types';

const ABOUT: Record<string, string> = {
  employee: 'Who holds what, person by person, with acknowledgement status.',
  department: 'Assets held in each department.',
  available: 'What is in stock and ready to hand out.',
  assigned: 'Everything currently with an employee.',
  returned: 'Returns in the period, with condition.',
  damaged_lost: 'Assets written off as damaged or lost.',
  purchases: 'Assets bought in the period, with price, vendor and warranty.',
  maintenance: 'Repairs and maintenance, with vendor and cost.',
};

export function ReportsView({ categories }: { categories: Category[] }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const qs = new URLSearchParams(Object.entries({ from, to, categoryId }).filter(([, v]) => v));
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader title="Report filters" description="Dates apply to returns, write-offs, purchases and maintenance." />
        <CardBody className="grid gap-4 sm:grid-cols-3">
          <Field label="From">{(p) => <DatePicker {...p} value={from} onChange={setFrom} max={to || undefined} />}</Field>
          <Field label="To">{(p) => <DatePicker {...p} value={to} onChange={setTo} min={from || undefined} />}</Field>
          <Field label="Category">{(p) => <Select {...p} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">All categories</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
        </CardBody>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2">
        {ASSET_REPORTS.map((k) => (
          <Card key={k}>
            <CardBody className="grid gap-3">
              <div><h2 className="text-sm font-semibold">{ASSET_REPORT_LABEL[k]}</h2><p className="text-[0.8125rem] text-fg-muted">{ABOUT[k]}</p></div>
              <div className="flex gap-2">
                <a className={buttonClass('secondary', 'sm')} href={`/asset-reports/${k}/xlsx?${qs}`}><FileSpreadsheet className="size-3.5" aria-hidden /> Excel</a>
                <a className={buttonClass('secondary', 'sm')} href={`/asset-reports/${k}/pdf?${qs}`}><FileText className="size-3.5" aria-hidden /> PDF</a>
              </div>
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}
