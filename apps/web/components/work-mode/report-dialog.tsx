'use client';
import { Alert, Button, Checkbox, Dialog, Field, Input, Select } from '@crew/ui';
import { BookmarkPlus, Download, FileSpreadsheet, Trash2 } from 'lucide-react';
import { useEffect, useState, useTransition } from 'react';
import { deleteReportAction, reportPeopleAction, savedReportsAction, saveReportAction } from '@/app/(app)/attendance/work-mode-actions';
import type { WorkModeLabels } from '@/lib/types';
import { DEFAULT_LABELS } from './parts';

const SHEETS: { key: string; label: string }[] = [
  { key: 'summary', label: 'Attendance Summary' }, { key: 'register', label: 'Detailed Register' }, { key: 'office', label: 'Office Attendance' },
  { key: 'remote', label: 'Work From Home' }, { key: 'hybrid', label: 'Hybrid Attendance' }, { key: 'events', label: 'Check-In and Check-Out Log' },
  { key: 'exceptions', label: 'Exceptions & Corrections' }, { key: 'employees', label: 'Employee Summary' },
];
type Saved = { id: string; name: string; filters: Record<string, string | string[]> };
const plus = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * "Export report": every attendance record matching the filters as an 8-sheet Excel workbook (frozen headers, filters,
 * real dates) or a CSV. Scope: everything you may see, the view on screen, or chosen people, departments or attendance
 * categories; any range up to full history. Filters can be saved. The API checks access and records every export.
 */
export function ReportButton({ from, to, today, filters = {}, section, own = false, labels = DEFAULT_LABELS, label = 'Export report' }: {
  from: string; to: string; today: string; filters?: Record<string, string | undefined>; section: string; own?: boolean; labels?: WorkModeLabels; label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx');
  const [range, setRange] = useState<'screen' | 'custom' | 'history'>('screen');
  const [cFrom, setCFrom] = useState(from);
  const [cTo, setCTo] = useState(to);
  const [scope, setScope] = useState<'current' | 'all' | 'selected'>('current');
  const [modes, setModes] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [find, setFind] = useState('');
  const [people, setPeople] = useState<{ employeeId: string; name: string; code: string; department: string | null }[]>([]);
  const [sheets, setSheets] = useState<string[]>(SHEETS.map((s) => s.key));
  const [saved, setSaved] = useState<Saved[]>([]);
  const [saveName, setSaveName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [, start] = useTransition();

  useEffect(() => { if (open && !own) void savedReportsAction().then((r) => r.ok && setSaved(r.data ?? [])); }, [open, own]);
  useEffect(() => {
    if (!open || own || scope !== 'selected') return;
    const id = window.setTimeout(() => start(async () => { const r = await reportPeopleAction(to, find.trim()); if (r.ok) setPeople(r.data!.rows); }), 250);
    return () => window.clearTimeout(id);
  }, [open, own, scope, find, to]);

  const span = range === 'custom' ? { from: cFrom, to: cTo } : range === 'history' ? { from: plus(today, -3650), to: today } : { from, to };
  const bad = !span.from || !span.to || span.to < span.from ? 'Choose a start and an end date.'
    : scope === 'selected' && !chosen.length && !modes.length ? 'Choose employees or attendance categories.'
      : format === 'xlsx' && !sheets.length ? 'Choose at least one sheet.' : null;
  const query = () => {
    const p = new URLSearchParams({ from: span.from, to: span.to, format, section, scope: scope === 'current' ? 'current' : scope });
    if (scope !== 'all') for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    if (scope === 'selected' && chosen.length) p.set('employeeIds', chosen.join(','));
    if (modes.length) p.set('modes', modes.join(','));
    if (format === 'xlsx' && sheets.length < SHEETS.length) p.set('sheets', sheets.join(','));
    return p;
  };
  const download = async () => {
    setError(null); setDone(null); setBusy('Preparing your file…');
    try {
      const res = await fetch(`/attendance-report?${query()}`);
      if (!res.ok) { setError((await res.text()) || 'The report could not be made.'); return; }
      const total = Number(res.headers.get('content-length')) || 0;
      const reader = res.body!.getReader();
      const parts: Uint8Array[] = [];
      let got = 0;
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        parts.push(value); got += value.length;
        setBusy(total ? `Downloading… ${Math.round((got / total) * 100)}%` : `Downloading… ${Math.round(got / 1024)} KB`);
      }
      const name = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `attendance-report.${format}`;
      const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: res.headers.get('content-type') ?? undefined }));
      const a = document.createElement('a');
      a.href = url; a.download = decodeURIComponent(name); a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
      setDone(`Downloaded ${decodeURIComponent(name)} with ${res.headers.get('x-report-rows') ?? 'all'} day records.`);
    } catch {
      setError('The download stopped. Check your connection and try again.');
    } finally { setBusy(null); }
  };
  const currentFilters = () => {
    const f: Record<string, string | string[]> = { format, range, scope };
    if (range === 'custom') { f.from = cFrom; f.to = cTo; }
    if (modes.length) f.modes = modes;
    if (chosen.length) f.employeeIds = chosen;
    if (sheets.length < SHEETS.length) f.sheets = sheets;
    return f;
  };
  const apply = (s: Saved) => {
    const f = s.filters;
    if (f.format === 'csv' || f.format === 'xlsx') setFormat(f.format);
    if (typeof f.range === 'string') setRange(f.range as typeof range);
    if (typeof f.scope === 'string') setScope(f.scope as typeof scope);
    if (typeof f.from === 'string') setCFrom(f.from);
    if (typeof f.to === 'string') setCTo(f.to);
    setModes(Array.isArray(f.modes) ? f.modes : []);
    setChosen(Array.isArray(f.employeeIds) ? f.employeeIds : []);
    setSheets(Array.isArray(f.sheets) ? f.sheets : SHEETS.map((x) => x.key));
  };
  const toggle = (list: string[], set: (v: string[]) => void, k: string, on: boolean) => set(on ? [...new Set([...list, k])] : list.filter((x) => x !== k));

  return (
    <>
      <Button size="sm" onClick={() => { setError(null); setDone(null); setOpen(true); }} data-testid="report-export"><FileSpreadsheet className="size-4" aria-hidden /> {label}</Button>
      <Dialog open={open} onClose={() => setOpen(false)} size="lg" title="Export attendance report" description="Every record that matches is included, not just one page. Only what you may see is in the file, and every export is recorded.">
        <div className="grid gap-4" data-testid="report-dialog">
          {error && <Alert tone="danger">{error}</Alert>}
          {done && <Alert tone="success">{done}</Alert>}
          {!own && saved.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-[0.8125rem]">
              <span className="text-fg-muted">Saved filters:</span>
              {saved.map((s) => (
                <span key={s.id} className="inline-flex items-center gap-1 rounded-full border border-border pl-2.5">
                  <button type="button" className="font-medium hover:text-accent" onClick={() => apply(s)}>{s.name}</button>
                  <button type="button" aria-label={`Delete ${s.name}`} className="rounded-full p-1 text-fg-subtle hover:text-danger" onClick={async () => { const r = await deleteReportAction(s.id); if (r.ok) setSaved(saved.filter((x) => x.id !== s.id)); }}><Trash2 className="size-3" /></button>
                </span>
              ))}
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Format">{(p) => <Select {...p} value={format} onChange={(e) => setFormat(e.target.value as 'xlsx')} data-testid="report-format"><option value="xlsx">Excel workbook (.xlsx, 8 sheets)</option><option value="csv">CSV (.csv, detailed register)</option></Select>}</Field>
            <Field label="Period">{(p) => (
              <Select {...p} value={range} onChange={(e) => setRange(e.target.value as typeof range)} data-testid="report-range">
                <option value="screen">As on screen ({from === to ? from : `${from} to ${to}`})</option>
                <option value="custom">Custom range</option>
                <option value="history">Full history (up to 10 years)</option>
              </Select>
            )}</Field>
          </div>
          {range === 'custom' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="From">{(p) => <Input {...p} type="date" value={cFrom} onChange={(e) => setCFrom(e.target.value)} />}</Field>
              <Field label="To">{(p) => <Input {...p} type="date" value={cTo} onChange={(e) => setCTo(e.target.value)} />}</Field>
            </div>
          )}
          {!own && (
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-[0.8125rem] font-medium">Records</legend>
              <div className="flex flex-wrap gap-4 text-[0.8125rem]">
                <label className="flex items-center gap-2"><input type="radio" name="report-scope" checked={scope === 'current'} onChange={() => setScope('current')} /> The view on screen (its filters)</label>
                <label className="flex items-center gap-2"><input type="radio" name="report-scope" checked={scope === 'all'} onChange={() => setScope('all')} /> Everything I can see</label>
                <label className="flex items-center gap-2"><input type="radio" name="report-scope" checked={scope === 'selected'} onChange={() => setScope('selected')} data-testid="report-scope-selected" /> Chosen employees or categories</label>
              </div>
              {scope === 'selected' && (
                <div className="grid gap-2">
                  <Input placeholder="Search by name or employee ID" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Search employees" />
                  <div className="max-h-40 overflow-y-auto rounded-lg border border-border p-2">
                    {people.map((x) => <Checkbox key={x.employeeId} label={`${x.name}${x.code ? ` (${x.code})` : ''}`} description={x.department ?? undefined} checked={chosen.includes(x.employeeId)} onChange={(e) => toggle(chosen, setChosen, x.employeeId, e.target.checked)} />)}
                    {!people.length && <p className="text-xs text-fg-subtle">Nobody matches.</p>}
                  </div>
                  <span className="text-xs text-fg-subtle">{chosen.length} employees chosen</span>
                </div>
              )}
            </fieldset>
          )}
          <fieldset className="grid gap-1">
            <legend className="mb-1 text-[0.8125rem] font-medium">Attendance categories</legend>
            <div className="flex flex-wrap gap-x-4">
              {([['office', labels.office], ['remote', labels.remote], ['hybrid', labels.hybrid], ['pending_verification', 'Pending verification']] as const).map(([k, l]) => (
                <Checkbox key={k} label={l} checked={modes.includes(k)} onChange={(e) => toggle(modes, setModes, k, e.target.checked)} />
              ))}
            </div>
            <span className="text-xs text-fg-subtle">{modes.length ? 'Only days in the ticked categories.' : 'All categories.'}</span>
          </fieldset>
          {format === 'xlsx' && (
            <fieldset className="grid gap-1">
              <legend className="mb-1 text-[0.8125rem] font-medium">Sheets</legend>
              <div className="grid gap-x-4 sm:grid-cols-2">
                {SHEETS.map((s) => <Checkbox key={s.key} label={s.label} checked={sheets.includes(s.key)} onChange={(e) => toggle(sheets, setSheets, s.key, e.target.checked)} />)}
              </div>
            </fieldset>
          )}
          {!own && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Save these filters as" className="min-w-52 flex-1">{(p) => <Input {...p} value={saveName} onChange={(e) => setSaveName(e.target.value)} maxLength={80} placeholder="For example: Hybrid this month" />}</Field>
              <Button variant="secondary" disabled={!saveName.trim()} onClick={async () => {
                const r = await saveReportAction({ name: saveName.trim(), filters: currentFilters() });
                if (!r.ok) { setError(r.message); return; }
                setSaved((r.data as unknown as Saved[]) ?? saved); setSaveName('');
              }}><BookmarkPlus className="size-4" /> Save</Button>
            </div>
          )}
          {bad && <p className="text-[0.8125rem] text-danger" role="alert">{bad}</p>}
          {busy && <p className="text-[0.8125rem] text-fg-muted" role="status" data-testid="report-progress">{busy}</p>}
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>
            <Button onClick={download} disabled={Boolean(bad) || Boolean(busy)} loading={Boolean(busy)} data-testid="report-download"><Download className="size-4" aria-hidden /> Download {format === 'xlsx' ? 'Excel' : 'CSV'}</Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
