'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { ArrowDown, ArrowUp, ExternalLink, Plus } from 'lucide-react';
import { useState } from 'react';
import { ResourceDialog } from '@/components/resource-form';
import type { CareerSiteSettings, Stage } from '@/lib/types';
import { addStageAction, archiveStageAction, renameStageAction, reorderStagesAction, saveCareerSiteAction } from '../../recruitment/actions';
import { STAGE_KIND } from '../../recruitment/labels';
import { useRunner } from '../../recruitment/use-runner';

const ADDABLE = { screen: 'Screening', interview: 'Interview', offer: 'Offer' };

export function RecruitmentSettingsView({ stages, site }: { stages: Stage[]; site: CareerSiteSettings }) {
  const { pending, notice, run } = useRunner();
  const [dialog, setDialog] = useState<null | 'add' | 'site' | Stage>(null);
  const ids = stages.map((s) => s.id);
  const move = (idx: number, dir: -1 | 1) => {
    const next = [...ids];
    [next[idx], next[idx + dir]] = [next[idx + dir]!, next[idx]!];
    run(() => reorderStagesAction(next));
  };
  return (
    <div className="grid gap-6">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Card>
        <CardHeader title="Pipeline stages" description="Every job uses these stages. Applied is always first and Hired always last; candidates reach Hired only by being hired from an accepted offer." action={<Button size="sm" onClick={() => setDialog('add')}><Plus className="size-3.5" /> Add stage</Button>} />
        <Table>
          <THead><tr><TH>Stage</TH><TH>Kind</TH><TH>Candidates now</TH><TH /></tr></THead>
          <TBody>
            {stages.map((s, idx) => {
              const fixed = s.kind === 'new' || s.kind === 'hired';
              return (
                <TR key={s.id}>
                  <TD className="font-medium">{s.name}</TD>
                  <TD><Badge tone="neutral">{STAGE_KIND[s.kind]}</Badge></TD>
                  <TD className="tabular-nums">{s.activeApplications ?? 0}</TD>
                  <TD className="text-right">
                    <div className="flex justify-end gap-1">
                      {!fixed && idx > 1 && <Button size="sm" variant="ghost" aria-label={`Move ${s.name} up`} disabled={pending} onClick={() => move(idx, -1)}><ArrowUp className="size-3.5" /></Button>}
                      {!fixed && idx < stages.length - 2 && <Button size="sm" variant="ghost" aria-label={`Move ${s.name} down`} disabled={pending} onClick={() => move(idx, 1)}><ArrowDown className="size-3.5" /></Button>}
                      <Button size="sm" variant="ghost" onClick={() => setDialog(s)}>Rename</Button>
                      {!fixed && <Button size="sm" variant="ghost" disabled={pending} onClick={() => confirm(`Remove ${s.name}? Move its candidates to another stage first.`) && run(() => archiveStageAction(s.id))}>Remove</Button>}
                    </div>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </Card>

      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2">Career site {site.enabled ? <Badge tone="success" dot>Live</Badge> : <Badge tone="neutral">Off</Badge>}</span>}
          description="A public page listing your published jobs, where people apply with their CV. Applicants must agree to your privacy notice; the version they agreed to is kept with their application."
          action={<Button size="sm" variant="secondary" onClick={() => setDialog('site')}>{site.configured === false ? 'Set up' : 'Edit'}</Button>}
        />
        <CardBody className="grid gap-2 text-[13px]">
          {site.configured === false ? <p className="text-fg-muted">Not set up yet.</p> : (
            <>
              <div><span className="text-fg-muted">Address: </span>{site.enabled ? <a className="inline-flex items-center gap-1 text-accent hover:underline" href={`/careers/${site.slug}`} target="_blank" rel="noreferrer">/careers/{site.slug} <ExternalLink className="size-3" /></a> : <span>/careers/{site.slug}</span>}</div>
              <div><span className="text-fg-muted">Headline: </span>{site.headline}</div>
              <div><span className="text-fg-muted">Privacy notice: </span>version {site.privacyNoticeVersion}</div>
              <div><span className="text-fg-muted">Candidate data kept: </span>{site.retentionDays} days after their last activity, unless they are still in process. Then their details are erased automatically.</div>
            </>
          )}
        </CardBody>
      </Card>

      <ResourceDialog
        open={dialog === 'add'}
        onClose={() => setDialog(null)}
        title="Add stage"
        description="New stages go just before Hired. Reorder them afterwards."
        fields={[
          { name: 'name', label: 'Name', required: true, placeholder: 'e.g. Take-home task' },
          { name: 'kind', label: 'Kind', type: 'select', required: true, options: Object.entries(ADDABLE).map(([value, label]) => ({ value, label })), hint: 'Used for reporting and to place offers automatically' },
        ]}
        initial={{ kind: 'interview' }}
        submitLabel="Add"
        onSubmit={(v) => addStageAction(v)}
      />
      {dialog && typeof dialog === 'object' && (
        <ResourceDialog open onClose={() => setDialog(null)} title={`Rename ${dialog.name}`} fields={[{ name: 'name', label: 'Name', required: true }]} initial={{ name: dialog.name }} submitLabel="Rename" onSubmit={(v) => renameStageAction(dialog.id, v)} />
      )}
      <ResourceDialog
        open={dialog === 'site'}
        onClose={() => setDialog(null)}
        title="Career site"
        fields={[
          { name: 'enabled', label: 'Site is live', type: 'select', required: true, half: true, options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] },
          { name: 'slug', label: 'Web address', required: true, half: true, hint: 'Your site is at /careers/ followed by this' },
          { name: 'headline', label: 'Headline', required: true },
          { name: 'intro', label: 'Introduction', type: 'textarea' },
          { name: 'privacyNotice', label: 'Privacy notice for applicants', type: 'textarea', required: true, hint: 'Say what you collect, why, who sees it, how long you keep it and how to ask for deletion. Changing it creates a new version.' },
          { name: 'retentionDays', label: 'Keep candidate data for (days)', type: 'number', required: true, hint: 'Between 30 and 1825. Counted from their last activity.' },
        ]}
        initial={{ ...site, enabled: String(site.enabled) }}
        submitLabel="Save"
        onSubmit={(v) => saveCareerSiteAction(v)}
      />
    </div>
  );
}
