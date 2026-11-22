'use client';
import { CRM_CAP_HELP, CRM_CAP_LABEL, CRM_CAPS, CRM_STAGE_KINDS, type CrmCap } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, Field, Input, Select, Switch, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { ArrowDown, ArrowUp, Plus } from 'lucide-react';
import { useState } from 'react';
import { useRunner } from '../../use-runner';
import { saveAccessAction, saveSettingsAction } from '../crm-actions';
import type { CrmContext } from '../crm-types';
import { NoticeBar, when } from '../crm-ui';

export interface AccessRow { key: string; name: string; enabled: boolean; caps: CrmCap[]; candidates: number; updatedAt: string | null; updatedBy: string | null; central: boolean; status: string; recruitment: boolean }
export interface CrmSettings {
  stages: { key: string; label: string; kind: string; active: boolean; system: boolean; candidates: number }[];
  sources: { key: string; label: string; active: boolean }[];
  retentionDays: number | null; matchFields: string[]; canEdit: boolean;
}
const KIND_LABEL: Record<string, string> = { open: 'In progress', won: 'Joined', lost: 'Closed', paused: 'On hold' };
const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 's_$1').slice(0, 40);

export function SettingsView({ ctx, settings, access }: { ctx: CrmContext; settings: CrmSettings; access: AccessRow[] | null }) {
  const { pending, notice, run } = useRunner();
  const [rows, setRows] = useState(access ?? []);
  const [stages, setStages] = useState(settings.stages);
  const [sources, setSources] = useState(settings.sources);
  const [retention, setRetention] = useState(settings.retentionDays?.toString() ?? '');
  const [match, setMatch] = useState(settings.matchFields);
  const [newStage, setNewStage] = useState('');
  const [newSource, setNewSource] = useState('');
  const edit = settings.canEdit;
  const changedAccess = rows.filter((r) => { const o = access?.find((x) => x.key === r.key); return !o || o.enabled !== r.enabled || o.caps.join() !== r.caps.join(); });
  const moveStage = (i: number, by: number) => { const n = [...stages]; const j = i + by; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j]!, n[i]!]; setStages(n); };

  return (
    <div className="grid gap-6">
      <NoticeBar notice={notice} />
      {access && (
        <Card>
          <CardHeader title="Candidate CRM Access" description="Switch Candidate CRM on for each HR Workspace and choose what it may do. Switching it off hides the CRM from that HR Workspace; its candidates are kept. Super Workspace always has full access." />
          <Table aria-label="Candidate CRM access">
            <THead><TR><TH>HR Workspace</TH><TH>Candidate CRM</TH>{CRM_CAPS.map((c) => <TH key={c} title={CRM_CAP_HELP[c]}>{CRM_CAP_LABEL[c]}</TH>)}<TH>Candidates</TH><TH>Last changed</TH></TR></THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.key} data-testid={`crm-access-${r.central ? 'central' : r.name}`}>
                  <TD><span className="font-medium">{r.name}</span>{!r.recruitment && <span className="block text-xs text-warning">Recruitment is switched off for this HR Workspace</span>}{r.status !== 'active' && <Badge tone="neutral" className="ml-2">{r.status}</Badge>}</TD>
                  <TD><Switch label={`Candidate CRM for ${r.name}`} checked={r.enabled} onChange={(v) => setRows(rows.map((x) => (x.key === r.key ? { ...x, enabled: v } : x)))} /></TD>
                  {CRM_CAPS.map((c) => (
                    <TD key={c}>
                      <input type="checkbox" className="size-4 accent-[var(--accent)]" aria-label={`${CRM_CAP_LABEL[c]} for ${r.name}`} disabled={!r.enabled} checked={r.caps.includes(c)}
                        onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, caps: e.target.checked ? [...x.caps, c].sort() as CrmCap[] : x.caps.filter((y) => y !== c) } : x)))} />
                    </TD>
                  ))}
                  <TD>{r.candidates}</TD>
                  <TD className="text-xs text-fg-muted">{r.updatedAt ? `${when(r.updatedAt)}${r.updatedBy ? ` · ${r.updatedBy}` : ''}` : 'Never'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <CardBody className="flex items-center gap-3 border-t border-border">
            <Button loading={pending} disabled={!changedAccess.length} onClick={() => run(() => saveAccessAction(changedAccess.map((r) => ({ key: r.key, enabled: r.enabled, caps: r.enabled ? r.caps : [] }))))}>Save access</Button>
            {changedAccess.length > 0 && <span className="text-[0.8125rem] text-fg-muted">{changedAccess.length} unsaved change{changedAccess.length === 1 ? '' : 's'}</span>}
          </CardBody>
        </Card>
      )}
      {!access && ctx.level === 'hr' && (
        <Card>
          <CardHeader title="Your access" description="What Super Workspace allows your HR Workspace to do in Candidate CRM." />
          <CardBody className="grid gap-3">
            {ctx.workspaces.map((w) => (
              <div key={w.key} className="text-[0.8125rem]"><span className="font-medium">{w.name}</span>: {w.caps.length ? w.caps.map((c) => <Badge key={c} tone="success" className="ml-1">{CRM_CAP_LABEL[c]}</Badge>) : <span className="text-fg-muted"> add, view and work on candidates</span>}</div>
            ))}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="Pipeline stages" description="The stages candidates move through. Stages in use cannot be deleted; switch them off instead." />
        <Table aria-label="Pipeline stages">
          <THead><TR><TH>Order</TH><TH>Stage</TH><TH>Means</TH><TH>Active</TH><TH>Candidates</TH></TR></THead>
          <TBody>
            {stages.map((s, i) => (
              <TR key={s.key}>
                <TD className="whitespace-nowrap">{edit && <><Button size="sm" variant="ghost" aria-label={`Move ${s.label} up`} onClick={() => moveStage(i, -1)}><ArrowUp className="size-3.5" /></Button><Button size="sm" variant="ghost" aria-label={`Move ${s.label} down`} onClick={() => moveStage(i, 1)}><ArrowDown className="size-3.5" /></Button></>}</TD>
                <TD>{edit ? <Input aria-label={`Name of ${s.key}`} value={s.label} onChange={(e) => setStages(stages.map((x) => (x.key === s.key ? { ...x, label: e.target.value } : x)))} /> : s.label}<span className="block font-mono text-xs text-fg-subtle">{s.key}</span></TD>
                <TD>{edit && !s.system ? <Select aria-label={`Meaning of ${s.label}`} value={s.kind} onChange={(e) => setStages(stages.map((x) => (x.key === s.key ? { ...x, kind: e.target.value } : x)))}>{CRM_STAGE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</Select> : KIND_LABEL[s.kind]}</TD>
                <TD><Switch label={`${s.label} active`} disabled={!edit || s.key === 'new'} checked={s.active} onChange={(v) => setStages(stages.map((x) => (x.key === s.key ? { ...x, active: v } : x)))} /></TD>
                <TD>{s.candidates}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
        {edit && (
          <CardBody className="flex flex-wrap items-end gap-3 border-t border-border">
            <Field label="New stage">{(p) => <Input {...p} value={newStage} onChange={(e) => setNewStage(e.target.value)} placeholder="Assessment sent" />}</Field>
            <Button variant="secondary" disabled={!slug(newStage) || stages.some((s) => s.key === slug(newStage))} onClick={() => { setStages([...stages, { key: slug(newStage), label: newStage.trim(), kind: 'open', active: true, system: false, candidates: 0 }]); setNewStage(''); }}><Plus className="size-3.5" /> Add stage</Button>
          </CardBody>
        )}
      </Card>

      <Card>
        <CardHeader title="Candidate sources" description="Where candidates come from, used in the form, filters, import and the overview." />
        <CardBody className="grid gap-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {sources.map((s) => (
              <div key={s.key} className="flex items-center gap-2">
                {edit ? <Input aria-label={`Name of source ${s.key}`} value={s.label} onChange={(e) => setSources(sources.map((x) => (x.key === s.key ? { ...x, label: e.target.value } : x)))} /> : <span className="flex-1 text-[0.8125rem]">{s.label}</span>}
                <Switch label={`${s.label} active`} disabled={!edit} checked={s.active} onChange={(v) => setSources(sources.map((x) => (x.key === s.key ? { ...x, active: v } : x)))} />
              </div>
            ))}
          </div>
          {edit && (
            <div className="flex flex-wrap items-end gap-3">
              <Field label="New source">{(p) => <Input {...p} value={newSource} onChange={(e) => setNewSource(e.target.value)} placeholder="Campus drive" />}</Field>
              <Button variant="secondary" disabled={!slug(newSource) || sources.some((s) => s.key === slug(newSource))} onClick={() => { setSources([...sources, { key: slug(newSource), label: newSource.trim(), active: true }]); setNewSource(''); }}><Plus className="size-3.5" /> Add source</Button>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Duplicates and data retention" description="How SampCrew spots the same person twice, and when inactive candidates’ personal details are erased." />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-[0.8125rem] font-medium">Treat two records as the same person when they share</legend>
            {[['email', 'Email address'], ['phone', 'Phone number'], ['candidate_code', 'Candidate ID (in imports)']].map(([k, l]) => (
              <Checkbox key={k} label={l!} disabled={!edit} checked={match.includes(k!)} onChange={(e) => setMatch(e.target.checked ? [...match, k!] : match.filter((x) => x !== k))} />
            ))}
          </fieldset>
          <Field label="Erase personal details after (days without activity)" hint="90 to 3650 days. Empty keeps the career site’s rule. Candidates with something in progress are never erased.">
            {(p) => <Input {...p} inputMode="numeric" disabled={!edit} value={retention} onChange={(e) => setRetention(e.target.value)} placeholder="730" />}
          </Field>
        </CardBody>
        {edit ? (
          <CardBody className="border-t border-border">
            <Button loading={pending} onClick={() => run(() => saveSettingsAction({
              stages: stages.map(({ key, label, kind, active }) => ({ key, label: label.trim(), kind, active })), sources: sources.map(({ key, label, active }) => ({ key, label: label.trim(), active })),
              retentionDays: retention ? Number(retention) : null, matchFields: match,
            }))}>Save settings</Button>
          </CardBody>
        ) : <CardBody className="border-t border-border"><Alert tone="info">Only Super Workspace changes these settings.</Alert></CardBody>}
      </Card>
    </div>
  );
}
