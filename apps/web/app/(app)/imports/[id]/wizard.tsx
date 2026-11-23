'use client';
import {
  CUSTOM_FIELD_TYPE_FOR_SAMPLE, CUSTOM_FIELD_TYPE_LABEL, DUPLICATE_STRATEGIES, DUPLICATE_STRATEGY_LABEL, IMPORT_JOB_STATUS_LABEL, IMPORT_TYPE_INFO,
  type DuplicateStrategy, type ImportJobView, type ImportRowView,
} from '@crew/contracts';
import { Alert, Badge, Button, buttonClass, Card, CardBody, CardHeader, Checkbox, cn, Field, Input, Select, Stat, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Check, Download, FilePlus2, Play, RefreshCw, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { ImportSteps } from '../new/upload-view';
import { STATUS_TONE } from '../status';
import { cancelImportAction, decideRowsAction, guessColumnAction, importJobAction, importRowsAction, runImportAction, saveMappingAction, validateImportAction } from '../actions';

type HrOption = { id: string; name: string };
type NewField = { label: string; type: (typeof CUSTOM_FIELD_TYPE_FOR_SAMPLE)[number]; options: string; required: boolean; visibleToEmployee: boolean; employeeEditable: boolean; searchable: boolean };
/** What one column becomes: a field, a new custom field, or nothing. "Likely" matches wait for the person to confirm them. */
type ColumnChoice = { kind: 'field'; field: string; confirmed: boolean } | { kind: 'new'; spec: NewField } | { kind: 'ignore' } | { kind: 'undecided' };

const FINISHED = ['completed', 'completed_with_errors', 'failed', 'cancelled'];
const NEW = '__create__';
const IGNORE = '__ignore__';

export function ImportWizard({ initial, hrWorkspaces, companyWide }: { initial: ImportJobView; hrWorkspaces: HrOption[]; companyWide: boolean }) {
  const [job, setJob] = useState(initial);
  const [remap, setRemap] = useState(false);
  const router = useRouter();
  // While an import runs, its progress is fetched every second and a half.
  useEffect(() => {
    if (job.status !== 'importing') return;
    const t = setInterval(async () => {
      const r = await importJobAction(job.id);
      if (r.ok && r.data) {
        setJob(r.data);
        if (r.data.status !== 'importing') router.refresh();
      }
    }, 1500);
    return () => clearInterval(t);
  }, [job.status, job.id, router]);

  const step = job.status === 'mapping' || remap ? 1 : job.status === 'validated' ? 2 : job.status === 'importing' ? 3 : 4;
  return (
    <div className="grid gap-6">
      <ImportSteps at={step} />
      {job.error && job.status !== 'importing' && <Alert tone="danger" title="The import stopped">{job.error}</Alert>}
      {step === 1 && <MappingStep job={job} hrWorkspaces={hrWorkspaces} companyWide={companyWide} onSaved={(j) => { setJob(j); setRemap(false); }} onBack={job.status === 'validated' ? () => setRemap(false) : undefined} />}
      {step === 2 && <PreviewStep job={job} setJob={setJob} onRemap={() => setRemap(true)} />}
      {step === 3 && <ProgressStep job={job} setJob={setJob} />}
      {step === 4 && <DoneStep job={job} setJob={setJob} />}
    </div>
  );
}

// Step 2: match the columns ------------------------------------------------------------------------------------------

function initialChoices(job: ImportJobView): ColumnChoice[] {
  const saved = new Map(job.mapping.map((m) => [m.column, m.field]));
  const created = new Set(job.createdFields.map((f) => f.column));
  return job.headers.map((_, column) => {
    if (saved.has(column)) {
      const f = saved.get(column);
      if (f) return { kind: 'field', field: f, confirmed: true };
      // Saved before as "not mapped": a column the person already looked at.
      if (job.status !== 'mapping' || created.has(column)) return { kind: 'ignore' };
    }
    const s = job.suggestions.find((x) => x.column === column);
    if (s?.field && s.confidence === 'exact') return { kind: 'field', field: s.field, confirmed: true };
    if (s?.field && s.confidence === 'likely') return { kind: 'field', field: s.field, confirmed: false };
    return { kind: 'undecided' };
  });
}

function MappingStep({ job, hrWorkspaces, companyWide, onSaved, onBack }: { job: ImportJobView; hrWorkspaces: HrOption[]; companyWide: boolean; onSaved: (j: ImportJobView) => void; onBack?: () => void }) {
  const info = IMPORT_TYPE_INFO[job.type];
  const fields = useMemo(() => job.fields ?? [], [job.fields]);
  const byKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const groups = useMemo(() => [...new Set(fields.map((f) => f.group))], [fields]);
  const [choices, setChoices] = useState<ColumnChoice[]>(() => initialChoices(job));
  const [duplicates, setDuplicates] = useState<DuplicateStrategy>(job.options.duplicates);
  const [matchBy, setMatchBy] = useState<string[]>(job.options.matchBy.length ? job.options.matchBy : info.matchFields.slice(0, 2));
  const [addMissing, setAddMissing] = useState(job.options.addMissingValues);
  const [hr, setHr] = useState<string>(job.options.hrWorkspaceId === null ? 'central' : job.options.hrWorkspaceId ?? hrWorkspaces[0]?.id ?? '');
  const [consent, setConsent] = useState(job.options.lawfulBasisConfirmed === true);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const canCreate = info.customFieldEntity !== null;

  const set = (column: number, c: ColumnChoice) => setChoices((cs) => cs.map((x, i) => (i === column ? c : x)));
  const usedBy = new Map<string, number>();
  choices.forEach((c, i) => { if (c.kind === 'field') usedBy.set(c.field, usedBy.has(c.field) ? -1 : i); });
  const unconfirmed = choices.filter((c) => c.kind === 'field' && !c.confirmed).length;
  const undecided = choices.filter((c) => c.kind === 'undecided').length;
  const twice = [...usedBy.entries()].filter(([, v]) => v === -1).map(([k]) => byKey.get(k)?.label ?? k);

  const pickNew = async (column: number) => {
    const header = job.headers[column] ?? `Column ${column + 1}`;
    set(column, { kind: 'new', spec: { label: header.replace(/\*+\s*$/, '').trim() || `Column ${column + 1}`, type: 'short_text', options: '', required: false, visibleToEmployee: false, employeeEditable: false, searchable: false } });
    // SampCrew suggests a type from the column's values; the person can change it.
    const g = await guessColumnAction(job.id, column);
    if (g.ok && g.data) {
      const type = (CUSTOM_FIELD_TYPE_FOR_SAMPLE as readonly string[]).includes(g.data.type) ? (g.data.type as NewField['type']) : 'short_text';
      setChoices((cs) => cs.map((x, i) => (i === column && x.kind === 'new' ? { kind: 'new', spec: { ...x.spec, type, options: g.data!.options.join('\n') } } : x)));
    }
  };

  const save = () => {
    setError(null);
    const mapping = choices.map((c, column) => ({ column, field: c.kind === 'field' ? c.field : null }));
    const newFields = choices.flatMap((c, column) => (c.kind === 'new' ? [{
      column, label: c.spec.label, type: c.spec.type, required: c.spec.required, options: c.spec.type === 'dropdown' ? c.spec.options.split('\n').map((o) => o.trim()).filter(Boolean) : [],
      visibleToEmployee: c.spec.visibleToEmployee, employeeEditable: c.spec.employeeEditable, searchable: c.spec.searchable,
    }] : []));
    const options = {
      duplicates, matchBy, addMissingValues: addMissing,
      ...(job.type === 'employees' && hr ? { hrWorkspaceId: hr === 'central' ? null : hr } : {}),
      ...(job.type === 'candidates' ? { lawfulBasisConfirmed: consent } : {}),
    };
    start(async () => {
      const r = await saveMappingAction(job.id, { mapping, newFields, options });
      if (r.ok && r.data) onSaved(r.data);
      else if (!r.ok) setError(r.fieldErrors ? Object.values(r.fieldErrors).join(' ') : r.message);
    });
  };

  const sample = (column: number) => job.sample.map((row) => row[column] ?? '').filter(Boolean).slice(0, 3);
  return (
    <>
      <Card>
        <CardHeader title="Match your columns" description="SampCrew matched the columns it is sure of. Check the suggested ones, and for each new column choose to create a field or ignore it. Nothing is saved to your records yet." />
        <Table aria-label="Columns">
          <THead><tr><TH>Column in your file</TH><TH>Sample values</TH><TH>SampCrew field</TH><TH>Match</TH></tr></THead>
          <TBody>
            {job.headers.map((header, column) => {
              const c = choices[column]!;
              const s = job.suggestions.find((x) => x.column === column);
              const value = c.kind === 'field' ? c.field : c.kind === 'new' ? NEW : c.kind === 'ignore' ? IGNORE : '';
              const clash = c.kind === 'field' && usedBy.get(c.field) === -1;
              return (
                <TR key={column}>
                  <TD className="align-top font-medium">{header || <span className="text-fg-muted">Column {column + 1} (no heading)</span>}</TD>
                  <TD className="max-w-[14rem] align-top text-[0.8125rem] text-fg-muted">{sample(column).map((v, i) => <div key={i} className="truncate">{v}</div>)}</TD>
                  <TD className="min-w-[16rem] align-top">
                    <Select aria-label={`Field for ${header}`} data-testid={`map-${column}`} value={value} className={cn(clash && 'border-danger')}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === NEW) void pickNew(column);
                        else if (v === IGNORE) set(column, { kind: 'ignore' });
                        else if (v) set(column, { kind: 'field', field: v, confirmed: true });
                        else set(column, { kind: 'undecided' });
                      }}>
                      <option value="">Choose…</option>
                      <option value={IGNORE}>Ignore this column</option>
                      {canCreate && <option value={NEW}>Create a new field</option>}
                      {groups.map((g) => (
                        <optgroup key={g} label={g}>
                          {fields.filter((f) => f.group === g).map((f) => <option key={f.key} value={f.key}>{f.label}{f.required ? ' *' : ''}</option>)}
                        </optgroup>
                      ))}
                    </Select>
                    {c.kind === 'field' && byKey.get(c.field)?.help && <p className="mt-1 text-xs text-fg-muted">{byKey.get(c.field)!.help}</p>}
                    {clash && <p className="mt-1 text-xs text-danger">Another column is matched to this field too</p>}
                    {c.kind === 'new' && <NewFieldForm spec={c.spec} employees={job.type === 'employees'} onChange={(spec) => set(column, { kind: 'new', spec })} />}
                  </TD>
                  <TD className="align-top">
                    {c.kind === 'field' && c.confirmed && (s?.field === c.field && s.confidence === 'exact' ? <Badge tone="success" dot>Matched</Badge> : <Badge tone="info" dot>Chosen</Badge>)}
                    {c.kind === 'field' && !c.confirmed && (
                      <div className="grid gap-1.5">
                        <Badge tone="warning" dot>Likely: please check</Badge>
                        <Button size="sm" variant="secondary" data-testid={`confirm-${column}`} onClick={() => set(column, { kind: 'field', field: c.field, confirmed: true })}><Check className="size-3.5" aria-hidden /> Confirm</Button>
                      </div>
                    )}
                    {c.kind === 'undecided' && (
                      <div className="grid gap-1.5" data-testid={`new-column-${column}`}>
                        <Badge tone="accent" dot><Sparkles className="size-3" aria-hidden /> New field detected</Badge>
                        <div className="flex flex-wrap gap-1.5">
                          {canCreate && <Button size="sm" variant="secondary" onClick={() => void pickNew(column)}><FilePlus2 className="size-3.5" aria-hidden /> Create field</Button>}
                          <Button size="sm" variant="ghost" onClick={() => set(column, { kind: 'ignore' })}><X className="size-3.5" aria-hidden /> Ignore</Button>
                        </div>
                      </div>
                    )}
                    {c.kind === 'new' && <Badge tone="accent" dot>New field</Badge>}
                    {c.kind === 'ignore' && <Badge tone="neutral">Not imported</Badge>}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </Card>

      <Card>
        <CardHeader title="Records you already have" description="How SampCrew finds a record that is already there, and what happens to it." />
        <CardBody className="grid gap-4 md:grid-cols-2">
          <Field label="When a row matches an existing record">{(p) => (
            <Select {...p} data-testid="duplicates" value={duplicates} onChange={(e) => setDuplicates(e.target.value as DuplicateStrategy)}>
              {DUPLICATE_STRATEGIES.map((d) => <option key={d} value={d}>{DUPLICATE_STRATEGY_LABEL[d]}</option>)}
            </Select>
          )}</Field>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-[0.8125rem] font-medium">Find existing records by</legend>
            {info.matchFields.map((m) => (
              <Checkbox key={m} label={byKey.get(m)?.label ?? m} checked={matchBy.includes(m)}
                onChange={(e) => setMatchBy((cur) => (e.target.checked ? info.matchFields.filter((x) => x === m || cur.includes(x)) : cur.filter((x) => x !== m)))} />
            ))}
          </fieldset>
          {['employees', 'candidates', 'clients', 'contacts'].includes(job.type) && (
            <Checkbox label="Add values missing from my lists" description="A department, skill, qualification, industry or source that is not in Master data yet is added (you see each one in the check). Work locations are never added this way." checked={addMissing} onChange={(e) => setAddMissing(e.target.checked)} />
          )}
          {job.type === 'employees' && (hrWorkspaces.length > 0 || companyWide) && (
            <Field label="HR Workspace" hint="Who looks after the people in this file. An HR Workspace column in the file wins for its row (Super Workspace only).">{(p) => (
              <Select {...p} data-testid="hr-workspace" value={hr} onChange={(e) => setHr(e.target.value)}>
                {companyWide && <option value="central">Central group (Super Workspace)</option>}
                {hrWorkspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </Select>
            )}</Field>
          )}
          {job.type === 'candidates' && (
            <Checkbox data-testid="consent" label="I confirm we may store these candidates’ details" description="For example, they applied to you or agreed to be contacted. This is recorded with the import." checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          )}
        </CardBody>
      </Card>

      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={save} loading={pending} disabled={unconfirmed > 0 || undecided > 0 || twice.length > 0 || matchBy.length === 0} data-testid="check-rows">Check every row</Button>
        {onBack && <Button variant="secondary" onClick={onBack}>Back to the check</Button>}
        <span className="text-[0.8125rem] text-fg-muted">
          {unconfirmed > 0 ? `Confirm or change ${unconfirmed} suggested ${unconfirmed === 1 ? 'match' : 'matches'}. ` : ''}
          {undecided > 0 ? `Choose what happens to ${undecided} new ${undecided === 1 ? 'column' : 'columns'}. ` : ''}
          {twice.length ? `${twice.join(', ')}: matched to two columns.` : ''}
        </span>
      </div>
    </>
  );
}

function NewFieldForm({ spec, employees, onChange }: { spec: NewField; employees: boolean; onChange: (s: NewField) => void }) {
  return (
    <div className="mt-2 grid gap-2 rounded-md border border-border bg-bg-subtle p-3">
      <Field label="Field name">{(p) => <Input {...p} value={spec.label} maxLength={120} onChange={(e) => onChange({ ...spec, label: e.target.value })} />}</Field>
      <Field label="Type" hint="Suggested from the values in this column">{(p) => (
        <Select {...p} value={spec.type} onChange={(e) => onChange({ ...spec, type: e.target.value as NewField['type'] })}>
          {CUSTOM_FIELD_TYPE_FOR_SAMPLE.map((t) => <option key={t} value={t}>{CUSTOM_FIELD_TYPE_LABEL[t]}</option>)}
        </Select>
      )}</Field>
      {spec.type === 'dropdown' && (
        <Field label="Choices" hint="One per line">{(p) => <textarea {...p} className="min-h-20 rounded-md border border-border bg-bg px-2 py-1 text-sm" value={spec.options} onChange={(e) => onChange({ ...spec, options: e.target.value })} />}</Field>
      )}
      <Checkbox label="Required" description="Rows without a value are not imported" checked={spec.required} onChange={(e) => onChange({ ...spec, required: e.target.checked })} />
      <Checkbox label="Searchable" description="Find records by this value in search" checked={spec.searchable} onChange={(e) => onChange({ ...spec, searchable: e.target.checked })} />
      {employees && <Checkbox label="Employees see it on their own profile" description="Super and HR Workspace always see it" checked={spec.visibleToEmployee} onChange={(e) => onChange({ ...spec, visibleToEmployee: e.target.checked, employeeEditable: e.target.checked && spec.employeeEditable })} />}
      {employees && spec.visibleToEmployee && <Checkbox label="Employees may change it" checked={spec.employeeEditable} onChange={(e) => onChange({ ...spec, employeeEditable: e.target.checked })} />}
    </div>
  );
}

// Step 3: check and preview ------------------------------------------------------------------------------------------

const FILTERS = [['all', 'All rows'], ['problems', 'Problems'], ['error', 'Errors'], ['warning', 'Warnings'], ['duplicate', 'Already in SampCrew'], ['valid', 'Ready']] as const;
const DONE_FILTERS = [['all', 'All rows'], ['imported', 'Added'], ['updated', 'Updated'], ['skipped', 'Skipped'], ['failed', 'Not imported'], ['problems', 'Problems']] as const;
const ROW_TONE = { pending: 'neutral', valid: 'success', warning: 'warning', error: 'danger', duplicate: 'info', imported: 'success', updated: 'accent', skipped: 'neutral', failed: 'danger' } as const;
const ROW_LABEL = { pending: 'Not checked', valid: 'Ready', warning: 'Ready, with a warning', error: 'Error', duplicate: 'Already in SampCrew', imported: 'Added', updated: 'Updated', skipped: 'Skipped', failed: 'Not imported' } as const;

function PreviewStep({ job, setJob, onRemap }: { job: ImportJobView; setJob: (j: ImportJobView) => void; onRemap: () => void }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const s = job.summary;
  const run = () => start(async () => {
    setError(null);
    const r = await runImportAction(job.id);
    if (r.ok && r.data) setJob(r.data); else if (!r.ok) setError(r.message);
  });
  const recheck = () => start(async () => {
    setError(null);
    const r = await validateImportAction(job.id);
    if (r.ok && r.data) { setJob(r.data); setReload((n) => n + 1); } else if (!r.ok) setError(r.message);
  });
  const cancel = () => start(async () => {
    const r = await cancelImportAction(job.id);
    if (r.ok && r.data) setJob(r.data); else if (!r.ok) setError(r.message);
  });
  // "Skip all" / "Update all": every row still waiting for a decision.
  const decideAll = (decision: 'skip' | 'update') => start(async () => {
    setError(null);
    const rows: number[] = [];
    for (let page = 1; ; page++) {
      const r = await importRowsAction(job.id, 'duplicate', page);
      if (!r.ok || !r.data) break;
      rows.push(...r.data.rows.filter((x) => !x.decision).map((x) => x.row));
      if (page * r.data.pageSize >= r.data.total) break;
    }
    if (!rows.length) return;
    const r = await decideRowsAction(job.id, rows.map((row) => ({ row, decision })));
    if (r.ok) { const j = await importJobAction(job.id); if (j.ok && j.data) setJob(j.data); setReload((n) => n + 1); } else setError(r.message);
  });
  const ready = s.new + (s.duplicates - job.undecided);
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-6" data-testid="import-summary">
        <Stat label="Rows" value={s.total.toLocaleString('en-IN')} />
        <Stat label="New records" value={s.new.toLocaleString('en-IN')} />
        <Stat label="Already in SampCrew" value={s.duplicates.toLocaleString('en-IN')} hint={job.undecided ? `${job.undecided} to decide` : DUPLICATE_STRATEGY_LABEL[job.options.duplicates]} />
        <Stat label="Warnings" value={s.warnings.toLocaleString('en-IN')} hint="Imported, worth a look" />
        <Stat label="Errors" value={s.errors.toLocaleString('en-IN')} hint="Not imported until fixed" />
        <Stat label="Valid" value={s.valid.toLocaleString('en-IN')} />
      </div>
      {job.createdFields.length > 0 && <Alert tone="info" title="New fields">{job.createdFields.map((f) => f.label).join(', ')}: created in Settings &gt; Custom fields, section Imported.</Alert>}
      {job.undecided > 0 && (
        <Alert tone="warning" title={`${job.undecided} ${job.undecided === 1 ? 'row matches' : 'rows match'} a record you already have`}>
          <p>Choose for each one below, or for all of them at once.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => decideAll('skip')} disabled={pending}>Skip all of them</Button>
            <Button size="sm" variant="secondary" onClick={() => decideAll('update')} disabled={pending}>Update all of them</Button>
          </div>
        </Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={run} loading={pending} disabled={!job.can.run || ready === 0} data-testid="run-import"><Play className="size-4" aria-hidden /> Import {ready.toLocaleString('en-IN')} {ready === 1 ? 'row' : 'rows'}</Button>
        {job.can.map && <Button variant="secondary" onClick={onRemap} disabled={pending}>Change columns</Button>}
        {job.can.validate && <Button variant="secondary" onClick={recheck} disabled={pending}><RefreshCw className="size-4" aria-hidden /> Check again</Button>}
        <a className={buttonClass('ghost')} href={`/import-report/${job.id}`}><Download className="size-4" aria-hidden /> Download the check</a>
        {job.can.cancel && <Button variant="ghost" onClick={cancel} disabled={pending}>Cancel import</Button>}
      </div>
      <p className="-mt-3 text-[0.8125rem] text-fg-muted">Rows with errors are left out. Fix them in your file and import it again, or download the check: it lists every problem with a suggested correction.</p>
      <RowsCard job={job} filters={FILTERS} reload={reload} onDecided={(j) => setJob(j)} title="Check every row" />
    </>
  );
}

function RowsCard({ job, filters, reload, onDecided, title }: { job: ImportJobView; filters: readonly (readonly [string, string])[]; reload: number; onDecided?: (j: ImportJobView) => void; title: string }) {
  const [status, setStatus] = useState<string>(job.summary.errors + job.summary.warnings > 0 && job.status === 'validated' ? 'problems' : 'all');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; pageSize: number; rows: ImportRowView[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetchRows = useCallback(async () => {
    const r = await importRowsAction(job.id, status, page);
    if (r.ok && r.data) setData(r.data); else if (!r.ok) setError(r.message);
  }, [job.id, status, page]);
  useEffect(() => { void fetchRows(); }, [fetchRows, reload]);
  const mapped = job.mapping.filter((m) => m.field).map((m) => job.headers[m.column]!).slice(0, 4);
  const fieldLabel = (key: string) => job.fields?.find((f) => f.key === key)?.label ?? key;
  const decide = async (row: number, decision: 'skip' | 'update' | 'create') => {
    setError(null);
    const r = await decideRowsAction(job.id, [{ row, decision }]);
    if (!r.ok) { setError(r.message); return; }
    const j = await importJobAction(job.id);
    if (j.ok && j.data) onDecided?.(j.data);
    void fetchRows();
  };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <Card>
      <CardHeader title={title} description="Each row with what the check found. Open a filter to see only the rows that need you." />
      <CardBody className="flex flex-wrap gap-2">
        {filters.map(([k, l]) => (
          <button key={k} type="button" onClick={() => { setStatus(k); setPage(1); }} aria-pressed={status === k}
            className={cn('rounded-full border px-3 py-1 text-[0.8125rem]', status === k ? 'border-accent bg-accent-subtle text-accent' : 'border-border text-fg-muted hover:text-fg')}>{l}</button>
        ))}
      </CardBody>
      {error && <div className="px-5 pb-3"><Alert tone="danger">{error}</Alert></div>}
      <Table aria-label="Rows">
        <THead><tr><TH>Row</TH><TH>Status</TH>{mapped.map((h) => <TH key={h}>{h}</TH>)}<TH>What the check found</TH></tr></THead>
        <TBody>
          {data?.rows.length === 0 && <TR><TD colSpan={mapped.length + 3} className="text-center text-fg-muted">No rows here</TD></TR>}
          {data?.rows.map((r) => (
            <TR key={r.row} data-testid={`row-${r.row}`}>
              <TD className="align-top">{r.row}</TD>
              <TD className="align-top"><Badge tone={ROW_TONE[r.status]} dot>{ROW_LABEL[r.status]}</Badge></TD>
              {mapped.map((h) => <TD key={h} className="max-w-[12rem] truncate align-top">{r.cells[h]}</TD>)}
              <TD className="min-w-[18rem] align-top text-[0.8125rem]">
                <ul className="grid gap-1">
                  {r.issues.map((i, n) => (
                    <li key={n} className={i.level === 'error' ? 'text-danger' : 'text-warning'}>
                      {i.column ? <span className="font-medium">{i.column}: </span> : null}{i.message}
                      {i.suggestion ? <span className="block text-fg-muted">{i.suggestion}</span> : null}
                    </li>
                  ))}
                </ul>
                {r.match && (
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span className="text-fg-muted">Matches {r.match.label} (same {fieldLabel(r.match.by).toLowerCase()})</span>
                    {r.status === 'duplicate' && job.status === 'validated' && job.can.map && (
                      <Select aria-label={`What to do with row ${r.row}`} data-testid={`decide-${r.row}`} className="h-8 w-auto py-0 text-[0.8125rem]" value={r.decision ?? ''} onChange={(e) => e.target.value && void decide(r.row, e.target.value as 'skip' | 'update' | 'create')}>
                        <option value="">Decide…</option>
                        <option value="skip">Skip it</option>
                        <option value="update">Update the existing record</option>
                        {!r.match.unique && <option value="create">Create a new record</option>}
                      </Select>
                    )}
                  </div>
                )}
                {r.record && (r.record.href ? <Link className="text-accent hover:underline" href={r.record.href}>{r.record.label || 'Open the record'}</Link> : <span>{r.record.label}</span>)}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      {data && pages > 1 && (
        <CardBody className="flex items-center gap-3 text-[0.8125rem]">
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span>Page {page} of {pages} · {data.total.toLocaleString('en-IN')} rows</span>
          <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </CardBody>
      )}
    </Card>
  );
}

// Steps 4 and 5: progress and report ----------------------------------------------------------------------------------

function ProgressStep({ job, setJob }: { job: ImportJobView; setJob: (j: ImportJobView) => void }) {
  const [pending, start] = useTransition();
  const pct = job.progress.total ? Math.round((job.progress.done / job.progress.total) * 100) : 0;
  return (
    <Card>
      <CardHeader title="Importing" description="Each row is saved on its own: a row that fails leaves nothing half done. You can leave this page; the import carries on and you get a notification when it finishes." />
      <CardBody className="grid gap-3">
        <div className="h-3 overflow-hidden rounded-full bg-bg-subtle" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Import progress">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-[0.8125rem]" data-testid="import-progress">{job.progress.done.toLocaleString('en-IN')} of {job.progress.total.toLocaleString('en-IN')} rows ({pct}%)</p>
        <div><Button variant="secondary" loading={pending} onClick={() => start(async () => { const r = await cancelImportAction(job.id); if (r.ok && r.data) setJob(r.data); })}>Stop the import</Button></div>
      </CardBody>
    </Card>
  );
}

function DoneStep({ job, setJob }: { job: ImportJobView; setJob: (j: ImportJobView) => void }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const s = job.summary;
  const tone = STATUS_TONE[job.status];
  const records = job.type === 'employees' ? `/employees?importId=${job.id}` : job.type === 'candidates' ? '/recruitment/candidates' : job.type === 'clients' || job.type === 'contacts' ? '/staffing/clients' : job.type === 'departments' ? '/organization' : '/settings/master-data';
  return (
    <>
      <Card>
        <CardHeader title="Import finished" description={FINISHED.includes(job.status) ? `Finished ${job.finishedAt ? new Date(job.finishedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : ''}` : 'The import stopped before the end. Rows already imported are kept, each one complete.'}
          action={<Badge tone={tone} dot>{IMPORT_JOB_STATUS_LABEL[job.status]}</Badge>} />
        <CardBody className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="import-result">
            <Stat label="Added" value={s.imported.toLocaleString('en-IN')} />
            <Stat label="Updated" value={s.updated.toLocaleString('en-IN')} />
            <Stat label="Skipped" value={s.skipped.toLocaleString('en-IN')} />
            <Stat label="Not imported" value={Math.max(0, s.total - s.imported - s.updated - s.skipped).toLocaleString('en-IN')} hint="Listed in the report with a suggested correction" />
          </div>
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="flex flex-wrap gap-2">
            <a className={buttonClass('primary')} href={`/import-report/${job.id}`} data-testid="import-report"><Download className="size-4" aria-hidden /> Download the report</a>
            <Link className={buttonClass('secondary')} href={records}>See the records</Link>
            {job.can.resume && <Button variant="secondary" loading={pending} onClick={() => start(async () => { setError(null); const r = await runImportAction(job.id); if (r.ok && r.data) setJob(r.data); else if (!r.ok) setError(r.message); })}><Play className="size-4" aria-hidden /> Carry on</Button>}
            <Link className={buttonClass('ghost')} href={`/imports/new?type=${job.type}${job.list ? `&list=${job.list}` : ''}`}>Import another file</Link>
          </div>
        </CardBody>
      </Card>
      <RowsCard job={job} filters={DONE_FILTERS} reload={0} title="What happened to each row" />
    </>
  );
}


