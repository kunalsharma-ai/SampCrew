'use client';
import { Alert, Button, buttonClass, Card, CardBody, CardHeader, Field, Select, cn } from '@crew/ui';
import { Download, FileSpreadsheet, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { uploadImportAction } from '../actions';

const STEPS = ['Upload', 'Match columns', 'Check and preview', 'Import', 'Report'];

export function ImportSteps({ at }: { at: number }) {
  return (
    <ol className="flex flex-wrap gap-2 text-[0.8125rem]" aria-label="Import steps">
      {STEPS.map((s, i) => (
        <li key={s} aria-current={i === at ? 'step' : undefined} className={cn('flex items-center gap-2 rounded-full border px-3 py-1', i === at ? 'border-accent bg-accent-subtle font-medium text-accent' : i < at ? 'border-border text-fg' : 'border-border text-fg-muted')}>
          <span className={cn('flex size-5 items-center justify-center rounded-full text-xs', i <= at ? 'bg-accent text-white' : 'bg-bg-subtle')}>{i + 1}</span>{s}
        </li>
      ))}
    </ol>
  );
}

export function UploadView({ type, list, lists, maxMb, maxRows }: { type: string; list: string | null; lists: { key: string; label: string }[]; maxMb: number; maxRows: number }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const pick = (f: File | null | undefined) => {
    setError(null);
    if (!f) return;
    if (/\.xls$/i.test(f.name)) { setError('This is an old Excel 97-2003 file (.xls). In Excel choose File > Save As > Excel Workbook (.xlsx), or CSV, and upload that.'); return; }
    if (!/\.(xlsx|csv)$/i.test(f.name)) { setError('Choose an Excel workbook (.xlsx) or a CSV file'); return; }
    if (f.size > maxMb * 1024 * 1024) { setError(`The file is over ${maxMb} MB. Split it into smaller files.`); return; }
    setFile(f);
  };
  const send = () => {
    if (!file) return;
    const form = new FormData();
    form.set('file', file);
    start(async () => {
      const r = await uploadImportAction(form, type, list);
      if (r.ok && r.data) router.push(`/imports/${r.data.id}`);
      else if (!r.ok) setError(r.message);
    });
  };
  return (
    <div className="grid gap-6">
      <ImportSteps at={0} />
      <Card>
        <CardHeader title="Upload your file" description={`Excel (.xlsx) or CSV, up to ${maxMb} MB and ${maxRows.toLocaleString('en-IN')} rows. The first row must hold the column headings. Nothing is saved to your records yet.`}
          action={<a className={buttonClass('secondary', 'sm')} href={`/import-template/${type}${list ? `?list=${list}` : ''}`}><Download className="size-3.5" aria-hidden /> Download the template</a>} />
        <CardBody className="grid gap-4">
          {lists.length > 0 && (
            <Field label="List" hint="Where the values go">{(p) => (
              <Select {...p} value={list ?? ''} onChange={(e) => router.push(`/imports/new?type=${type}&list=${e.target.value}`)}>
                {lists.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
              </Select>
            )}</Field>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
          <div
            role="button" tabIndex={0} data-testid="import-dropzone"
            onClick={() => input.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') input.current?.click(); }}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files?.[0]); }}
            className={cn('flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-12 text-center transition-colors', over ? 'border-accent bg-accent-subtle' : 'border-border hover:border-accent')}
          >
            <FileSpreadsheet className="size-8 text-accent" aria-hidden />
            {file ? <><span className="font-medium">{file.name}</span><span className="text-xs text-fg-muted">{(file.size / 1024).toFixed(0)} KB · click to choose another</span></> : <><span className="font-medium">Drop your file here, or click to choose it</span><span className="text-xs text-fg-muted">.xlsx or .csv</span></>}
            <input ref={input} type="file" className="sr-only" data-testid="import-file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => pick(e.target.files?.[0])} />
          </div>
          <div><Button onClick={send} disabled={!file} loading={pending}><Upload className="size-4" aria-hidden /> Upload and match columns</Button></div>
        </CardBody>
      </Card>
    </div>
  );
}
