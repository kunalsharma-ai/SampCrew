'use client';
import { IMPORT_DUPLICATE_ACTIONS } from '@crew/contracts';
import { Alert, Badge, Button, buttonClass, Card, CardBody, CardHeader, Checkbox, EmptyState, Field, Input, Select, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Download, FileSpreadsheet, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useMfaRetry } from '@/components/mfa-step-up';
import type { ActionResult } from '@/lib/api';
import { cancelImportAction, checkImportAction, deleteTemplateAction, runImportAction, uploadImportAction } from '../crm-actions';
import type { CrmContext } from '../crm-types';
import { when } from '../crm-ui';

export interface ImportHistory {
  imports: { id: string; fileName: string; status: string; counts: Record<string, number>; createdAt: string; completedAt: string | null; by: string | null; hrWorkspace: string; duplicateAction: string | null }[];
  canImport: boolean;
}
interface Upload {
  id: string; fileName: string; headers: string[]; rowCount: number; sample: string[][]; hrWorkspaceId: string | null; hrWorkspaceName: string;
  fields: { key: string; label: string; group: string }[]; templates: { id: string; name: string; mapping: Record<string, string | null> }[];
  mapping: { templateId: string | null; templateName: string | null; fields: Record<string, string | null> };
}
interface Problem { row: number; status: string; name: string | null; errors: { column: string; message: string }[]; match: { id: string; code: string | null; name: string; by: string; visible: boolean } | null }
interface Checked { counts: { total: number; ready: number; errors: number; duplicates: number }; problems: Problem[]; preview: { row: number; name: string; email: string | null; phone: string | null; currentCompany: string | null; stage: string; source: string | null }[] }
interface Result { counts: Record<string, number>; problems: { row: number; status: string; name: string | null; message?: string; errors?: { column: string; message: string }[] }[] }

const DUP_LABEL: Record<string, string> = { skip: 'Skip duplicates', update: 'Update the existing candidate', create: 'Add as a new candidate', review: 'Let me decide for each' };
const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = { completed: 'success', running: 'info', checked: 'warning', uploaded: 'neutral', cancelled: 'neutral', failed: 'danger' };

export function ImportWizard({ ctx, history }: { ctx: CrmContext; history: ImportHistory }) {
  const router = useRouter();
  const withMfa = useMfaRetry();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [owner, setOwner] = useState<string>(ctx.level === 'hr' && ctx.workspaces[0]?.key !== 'central' ? ctx.workspaces[0]?.key ?? '' : '');
  const [up, setUp] = useState<Upload | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [dup, setDup] = useState<string>('review');
  const [defaults, setDefaults] = useState({ source: '', stage: '', assignedRecruiterMembershipId: '', tag: '' });
  const [rowActions, setRowActions] = useState<Record<string, 'skip' | 'update' | 'create'>>({});
  const [saveAs, setSaveAs] = useState('');
  const [lawful, setLawful] = useState(false);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const call = <T,>(fn: () => Promise<ActionResult<T>>, then: (d: T) => void) => start(async () => {
    setError(null);
    const r = await withMfa(fn);
    if (!r.ok) { setError(r.message); return; }
    then(r.data as T);
  });
  const plan = () => ({
    mapping, duplicateAction: dup, rowActions, lawfulBasisConfirmed: lawful || undefined, saveTemplate: saveAs.trim() || undefined,
    defaults: Object.fromEntries(Object.entries(defaults).filter(([, v]) => v)),
  });
  const reset = () => { setUp(null); setChecked(null); setResult(null); setRowActions({}); setSaveAs(''); setLawful(false); router.refresh(); };
  const used = Object.values(mapping).filter(Boolean);
  const step = result ? 4 : checked ? 3 : up ? 2 : 1;
  const groups = up ? [...new Set(up.fields.map((f) => f.group))] : [];

  return (
    <div className="grid gap-6">
      <ol className="flex flex-wrap gap-2 text-[0.8125rem]" aria-label="Import steps">
        {['Upload file', 'Match columns', 'Check rows', 'Done'].map((s, i) => (
          <li key={s} aria-current={step === i + 1 ? 'step' : undefined}><Badge tone={step === i + 1 ? 'accent' : step > i + 1 ? 'success' : 'neutral'}>{i + 1}. {s}</Badge></li>
        ))}
      </ol>
      {error && <Alert tone="danger">{error}</Alert>}

      {step === 1 && history.canImport && (
        <Card>
          <CardHeader title="Upload a spreadsheet" description="Excel (.xlsx) or CSV, up to 5,000 candidates and 8 MB. The first row must hold the column headings." action={<a className={buttonClass('secondary', 'sm')} href="/crm-import/template" download><Download className="size-3.5" /> Sample file</a>} />
          <CardBody>
            <form className="grid gap-4 sm:grid-cols-[1fr_16rem_auto] sm:items-end" onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              if (!(fd.get('file') as File | null)?.size) { setError('Choose a file to import'); return; }
              call(() => uploadImportAction(fd, owner || null), (d) => { const u = d as unknown as Upload; setUp(u); setMapping(u.mapping.fields); });
            }}>
              <Field label="File" required>{(p) => <Input {...p} type="file" name="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />}</Field>
              {ctx.level === 'super' ? (
                <Field label="Import into">{(p) => <Select {...p} value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">Super Workspace (company-wide)</option>{ctx.hrWorkspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}</Field>
              ) : ctx.workspaces.length > 1 ? (
                <Field label="Import into">{(p) => <Select {...p} value={owner} onChange={(e) => setOwner(e.target.value)}>{ctx.workspaces.filter((w) => w.caps.includes('import')).map((w) => <option key={w.key} value={w.key === 'central' ? '' : w.key}>{w.name}</option>)}</Select>}</Field>
              ) : <span />}
              <Button type="submit" loading={pending}><Upload className="size-3.5" /> Upload</Button>
            </form>
          </CardBody>
        </Card>
      )}

      {step === 2 && up && (
        <Card>
          <CardHeader title="Match columns" description={`${up.fileName} · ${up.rowCount} row${up.rowCount === 1 ? '' : 's'} · into ${up.hrWorkspaceName}${up.mapping.templateName ? ` · using saved mapping “${up.mapping.templateName}”` : ''}`} />
          <CardBody className="grid gap-6">
            {up.templates.length > 0 && (
              <Field label="Saved mapping">{(p) => (
                <Select {...p} defaultValue={up.mapping.templateId ?? ''} onChange={(e) => { const t = up.templates.find((x) => x.id === e.target.value); if (t) setMapping(Object.fromEntries(up.headers.map((h) => [h, t.mapping[h] ?? null]))); }}>
                  <option value="">Choose a saved mapping…</option>{up.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </Select>
              )}</Field>
            )}
            <Table aria-label="Column mapping">
              <THead><TR><TH>Column in your file</TH><TH>Example</TH><TH>SampCrew field</TH></TR></THead>
              <TBody>
                {up.headers.map((h, i) => (
                  <TR key={h}>
                    <TD className="font-medium">{h}</TD>
                    <TD className="max-w-60 truncate text-fg-muted">{up.sample.map((r) => r[i]).filter(Boolean).slice(0, 2).join(' · ') || '—'}</TD>
                    <TD>
                      <Select aria-label={`Field for ${h}`} value={mapping[h] ?? ''} onChange={(e) => setMapping({ ...mapping, [h]: e.target.value || null })}>
                        <option value="">Don’t import</option>
                        {groups.map((g) => (
                          <optgroup key={g} label={g}>
                            {up.fields.filter((f) => f.group === g).map((f) => <option key={f.key} value={f.key} disabled={used.includes(f.key) && mapping[h] !== f.key}>{f.label}</option>)}
                          </optgroup>
                        ))}
                      </Select>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="When a candidate already exists">{(p) => <Select {...p} value={dup} onChange={(e) => setDup(e.target.value)}>{IMPORT_DUPLICATE_ACTIONS.map((a) => <option key={a} value={a}>{DUP_LABEL[a]}</option>)}</Select>}</Field>
              <Field label="Source for new candidates">{(p) => <Select {...p} value={defaults.source} onChange={(e) => setDefaults({ ...defaults, source: e.target.value })}><option value="">From the file, else Import</option>{ctx.sources.filter((s) => s.active).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</Select>}</Field>
              <Field label="Stage for new candidates">{(p) => <Select {...p} value={defaults.stage} onChange={(e) => setDefaults({ ...defaults, stage: e.target.value })}><option value="">From the file, else New Candidate</option>{ctx.stages.filter((s) => s.active).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</Select>}</Field>
              <Field label="Assign to recruiter">{(p) => <Select {...p} value={defaults.assignedRecruiterMembershipId} onChange={(e) => setDefaults({ ...defaults, assignedRecruiterMembershipId: e.target.value })}><option value="">Nobody</option>{ctx.recruiters.map((r) => <option key={r.membershipId} value={r.membershipId}>{r.name}</option>)}</Select>}</Field>
              <Field label="Tag every candidate">{(p) => <Input {...p} value={defaults.tag} onChange={(e) => setDefaults({ ...defaults, tag: e.target.value })} placeholder="campus-2026" />}</Field>
              <Field label="Save this mapping as" hint="Optional, for the next file with the same columns">{(p) => <Input {...p} value={saveAs} onChange={(e) => setSaveAs(e.target.value)} />}</Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button loading={pending} disabled={!used.length} onClick={() => call(() => checkImportAction(up.id, plan()), (d) => setChecked(d as unknown as Checked))}>Check rows</Button>
              <Button variant="ghost" onClick={() => call(() => cancelImportAction(up.id), reset)}>Cancel import</Button>
            </div>
          </CardBody>
        </Card>
      )}

      {step === 3 && up && checked && (
        <Card>
          <CardHeader title="Check rows" description="Nothing has been imported yet. Fix the file and upload again, or import the rows that are ready." />
          <CardBody className="grid gap-5">
            <div className="flex flex-wrap gap-2 text-[0.8125rem]" data-testid="crm-import-counts">
              <Badge tone="neutral">{checked.counts.total} rows</Badge><Badge tone="success">{checked.counts.ready} ready</Badge>
              <Badge tone="warning">{checked.counts.duplicates} already exist</Badge><Badge tone="danger">{checked.counts.errors} with problems</Badge>
            </div>
            {checked.preview.length > 0 && (
              <Table aria-label="Ready rows">
                <THead><TR><TH>Row</TH><TH>Name</TH><TH>Email</TH><TH>Phone</TH><TH>Company</TH></TR></THead>
                <TBody>{checked.preview.map((p) => <TR key={p.row}><TD>{p.row}</TD><TD>{p.name}</TD><TD>{p.email ?? '—'}</TD><TD>{p.phone ?? '—'}</TD><TD>{p.currentCompany ?? '—'}</TD></TR>)}</TBody>
              </Table>
            )}
            {checked.problems.length > 0 && (
              <Table aria-label="Rows to look at">
                <THead><TR><TH>Row</TH><TH>Name</TH><TH>What we found</TH><TH>Do</TH></TR></THead>
                <TBody>
                  {checked.problems.map((p) => (
                    <TR key={p.row}>
                      <TD>{p.row}</TD><TD>{p.name ?? '—'}</TD>
                      <TD className="text-[0.8125rem]">
                        {p.match && <span className="block">Same {p.match.by.replace('_', ' ')} as {p.match.visible ? <a className="text-accent hover:underline" href={`/recruitment/crm/candidates/${p.match.id}`} target="_blank" rel="noopener">{p.match.name} ({p.match.code})</a> : 'a candidate in another HR Workspace'}</span>}
                        {p.errors.map((e, i) => <span key={i} className="block text-danger">{e.column}: {e.message}</span>)}
                      </TD>
                      <TD>
                        {p.status === 'duplicate' && p.match?.visible && dup === 'review' ? (
                          <Select aria-label={`What to do with row ${p.row}`} value={rowActions[String(p.row)] ?? 'skip'} onChange={(e) => setRowActions({ ...rowActions, [String(p.row)]: e.target.value as 'skip' })}>
                            <option value="skip">Skip</option><option value="update">Update existing</option><option value="create">Add as new</option>
                          </Select>
                        ) : <span className="text-xs text-fg-muted">{p.status === 'duplicate' ? DUP_LABEL[dup] : 'Skipped'}</span>}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
            <Checkbox label="These candidates agreed to share their details with us for recruitment" description="Required to import. SampCrew records who confirmed it." checked={lawful} onChange={(e) => setLawful(e.target.checked)} />
            <div className="flex flex-wrap gap-2">
              <Button loading={pending} disabled={!lawful} onClick={() => call(() => runImportAction(up.id, plan()), (d) => setResult(d as unknown as Result))}>Import candidates</Button>
              <Button variant="secondary" onClick={() => setChecked(null)}>Back to mapping</Button>
              <Button variant="ghost" onClick={() => call(() => cancelImportAction(up.id), reset)}>Cancel import</Button>
            </div>
          </CardBody>
        </Card>
      )}

      {step === 4 && up && result && (
        <Card>
          <CardHeader title="Import finished" description={up.fileName} />
          <CardBody className="grid gap-4">
            <div className="flex flex-wrap gap-2 text-[0.8125rem]" data-testid="crm-import-result">
              <Badge tone="success">{result.counts.created ?? 0} added</Badge><Badge tone="info">{result.counts.updated ?? 0} updated</Badge>
              <Badge tone="neutral">{result.counts.skipped ?? 0} skipped</Badge><Badge tone="danger">{result.counts.failed ?? 0} failed</Badge>
            </div>
            {result.problems.length > 0 && <a className={buttonClass('secondary', 'sm', 'w-fit')} href={`/crm-import/${up.id}/problems`} download><Download className="size-3.5" /> Download error report</a>}
            <div className="flex gap-2"><a className={buttonClass('primary', 'sm')} href="/recruitment/crm/candidates?sort=recent&view=all">See candidates</a><Button size="sm" variant="ghost" onClick={reset}>Import another file</Button></div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="Import history" description="The last 50 imports you can see." />
        {history.imports.length === 0 ? <EmptyState icon={<FileSpreadsheet className="size-5" />} title="No imports yet" /> : (
          <Table aria-label="Import history">
            <THead><TR><TH>File</TH><TH>Into</TH><TH>Status</TH><TH>Rows</TH><TH>Added</TH><TH>Updated</TH><TH>Problems</TH><TH>By</TH><TH>When</TH><TH /></TR></THead>
            <TBody>
              {history.imports.map((i) => (
                <TR key={i.id}>
                  <TD className="font-medium">{i.fileName}</TD><TD>{i.hrWorkspace}</TD><TD><Badge tone={STATUS_TONE[i.status] ?? 'neutral'}>{i.status}</Badge></TD>
                  <TD>{i.counts.total ?? 0}</TD><TD>{i.counts.created ?? 0}</TD><TD>{i.counts.updated ?? 0}</TD><TD>{(i.counts.failed ?? 0) + (i.counts.skipped ?? 0) || (i.counts.errors ?? 0)}</TD>
                  <TD>{i.by ?? '—'}</TD><TD className="whitespace-nowrap">{when(i.createdAt)}</TD>
                  <TD>{i.status === 'completed' && ((i.counts.failed ?? 0) + (i.counts.skipped ?? 0)) > 0 && <a className="text-accent hover:underline" href={`/crm-import/${i.id}/problems`} download>Error report</a>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
      {up && up.templates.length > 0 && step === 2 && (
        <Card>
          <CardHeader title="Saved mappings" description="Mappings saved for this workspace." />
          <ul className="divide-y divide-border">
            {up.templates.map((t) => <li key={t.id} className="flex items-center justify-between px-5 py-2.5 text-[0.8125rem]"><span>{t.name}</span><Button size="sm" variant="ghost" onClick={() => call(() => deleteTemplateAction(t.id), () => setUp({ ...up, templates: up.templates.filter((x) => x.id !== t.id) }))}>Delete</Button></li>)}
          </ul>
        </Card>
      )}
    </div>
  );
}
