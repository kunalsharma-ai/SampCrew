'use client';
import { type RequisitionSkills, SKILL_LEVEL_LABEL, type SkillCatalogueEntry } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardHeader, Select, Table, TBody, TD, TH, THead, TR, cn } from '@crew/ui';
import { Plus, Save, X } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { setJobSkillsAction } from '../../../insights/universe/lens-actions';

/** The skills a job asks for, and people already in the workspace who have them: a place to look before advertising. */
export function JobSkills({ requisitionId, initial, catalogue }: { requisitionId: string; initial: RequisitionSkills; catalogue: SkillCatalogueEntry[] }) {
  const [data, setData] = useState(initial);
  const [draft, setDraft] = useState(initial.skills.map((s) => ({ skillId: s.skillId, minLevel: s.minLevel })));
  const [pick, setPick] = useState({ skillId: '', minLevel: '2' });
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const name = (id: string) => catalogue.find((k) => k.id === id)?.name ?? data.skills.find((k) => k.skillId === id)?.name ?? 'Skill';
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.skills.map((s) => ({ skillId: s.skillId, minLevel: s.minLevel })));
  const save = () => start(async () => {
    const r = await setJobSkillsAction(requisitionId, { skills: draft });
    setMsg({ tone: r.ok ? 'success' : 'danger', text: r.ok ? `Skills saved. ${r.data?.matches.length ?? 0} people here have some of them.` : [r.message, ...Object.values(r.fieldErrors ?? {})].filter(Boolean).join(' ') });
    if (r.ok && r.data) { setData(r.data); setDraft(r.data.skills.map((s) => ({ skillId: s.skillId, minLevel: s.minLevel }))); }
  });

  return (
    <Card aria-label="Skills for this job" className="mt-4">
      <CardHeader title="Skills for this job" description="What the job asks for, and people already here who have it, best match first. Only people you can see are listed." />
      {msg && <div className="px-4 pb-3"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
        {draft.map((s) => (
          <span key={s.skillId} className="inline-flex items-center gap-1 rounded-full border border-border bg-bg-subtle py-0.5 pl-3 pr-1 text-[0.8125rem]">
            {name(s.skillId)} · {SKILL_LEVEL_LABEL[s.minLevel]}+
            {data.canEdit && <button type="button" aria-label={`Remove ${name(s.skillId)}`} className="rounded-full p-0.5 hover:bg-bg-muted" onClick={() => setDraft(draft.filter((x) => x.skillId !== s.skillId))}><X className="size-3.5" /></button>}
          </span>
        ))}
        {!draft.length && <span className="text-[0.8125rem] text-fg-subtle">No skills named yet.</span>}
      </div>
      {data.canEdit && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
          <Select aria-label="Skill to ask for" className="!w-56" value={pick.skillId} onChange={(e) => setPick({ ...pick, skillId: e.target.value })}>
            <option value="">Choose a skill</option>
            {catalogue.filter((k) => !draft.some((d) => d.skillId === k.id)).map((k) => <option key={k.id} value={k.id}>{k.name}{k.category ? ` (${k.category})` : ''}</option>)}
          </Select>
          <Select aria-label="Lowest level that counts" className="!w-36" value={pick.minLevel} onChange={(e) => setPick({ ...pick, minLevel: e.target.value })}>
            {[1, 2, 3, 4].map((l) => <option key={l} value={l}>{SKILL_LEVEL_LABEL[l]} or above</option>)}
          </Select>
          <Button size="sm" variant="secondary" disabled={!pick.skillId || draft.length >= 15} onClick={() => { setDraft([...draft, { skillId: pick.skillId, minLevel: Number(pick.minLevel) }]); setPick({ ...pick, skillId: '' }); }}><Plus className="size-3.5" /> Add</Button>
          <Button size="sm" className="ml-auto" onClick={save} loading={pending} disabled={!dirty}><Save className="size-3.5" /> Save skills</Button>
        </div>
      )}
      {data.skills.length > 0 && (
        data.matches.length ? (
          <div className="overflow-x-auto border-t border-border">
            <Table aria-label="People here who match">
              <THead><TR><TH>Person</TH><TH>Department</TH><TH className="text-right">Match</TH><TH>Skills</TH></TR></THead>
              <TBody>
                {data.matches.map((m) => (
                  <TR key={m.employeeId}>
                    <TD><Link href={`/employees/${m.employeeId}`} className="font-medium text-accent hover:underline">{m.name}</Link>{m.title && <span className="block text-xs text-fg-subtle">{m.title}</span>}</TD>
                    <TD>{m.departmentName ?? '—'}</TD>
                    <TD className="text-right tabular-nums"><span className={cn('font-semibold', m.score >= 80 ? 'text-success' : m.score >= 50 ? 'text-warning' : 'text-fg-muted')}>{m.score}%</span><span className="block text-xs text-fg-subtle">{m.met} of {m.skills.length} at level</span></TD>
                    <TD>
                      <div className="flex flex-wrap gap-1">
                        {m.skills.map((k) => (
                          <Badge key={k.skillId} tone={k.level == null ? 'neutral' : k.level >= k.minLevel ? 'success' : 'warning'}>
                            {k.name}: {k.level == null ? 'no' : SKILL_LEVEL_LABEL[k.level]}
                          </Badge>
                        ))}
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        ) : <p className="border-t border-border px-4 py-3 text-[0.8125rem] text-fg-subtle">Nobody you can see has these skills yet.</p>
      )}
    </Card>
  );
}
