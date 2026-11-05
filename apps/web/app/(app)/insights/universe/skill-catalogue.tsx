'use client';
import type { SkillCatalogueEntry } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardHeader, Input, Select, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { GitMerge, Plus, Save, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { createSkillAction, deleteSkillAction, mergeSkillAction, updateSkillAction } from './lens-actions';

type Msg = { tone: 'success' | 'danger'; text: string } | null;
const text = (r: { ok: boolean; message?: string; fieldErrors?: Record<string, string> }) => [r.message, ...Object.values(r.fieldErrors ?? {})].filter(Boolean).join(' ');

/**
 * The workspace's skill list. People who look after every employee record can add, rename, group, merge and remove
 * skills; everyone else sees the list with how many of the people they can see hold each one.
 */
export function SkillCatalogue({ skills, canManage }: { skills: SkillCatalogueEntry[]; canManage: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<Msg>(null);
  const [pending, start] = useTransition();
  const [edits, setEdits] = useState<Record<string, { name: string; category: string }>>({});
  const [into, setInto] = useState<Record<string, string>>({});
  const [add, setAdd] = useState({ name: '', category: '' });
  const run = (fn: () => Promise<{ ok: boolean; message?: string; fieldErrors?: Record<string, string> }>, after?: () => void) => start(async () => {
    const r = await fn();
    setMsg({ tone: r.ok ? 'success' : 'danger', text: text(r) || (r.ok ? 'Done.' : 'Something went wrong') });
    if (r.ok) { after?.(); router.refresh(); }
  });
  const value = (s: SkillCatalogueEntry) => edits[s.id] ?? { name: s.name, category: s.category ?? '' };
  const changed = (s: SkillCatalogueEntry) => { const v = value(s); return v.name.trim() !== s.name || (v.category.trim() || null) !== s.category; };
  const categories = [...new Set(skills.map((s) => s.category).filter(Boolean))] as string[];

  return (
    <Card aria-label="Skill list">
      <CardHeader
        title="Skill list"
        description={canManage
          ? 'Rename skills, group them by category, merge duplicates (holders keep the higher level) or remove ones no longer used. Changes apply to everyone who holds the skill and every job that asks for it.'
          : 'Skills in this workspace, with how many of the people you can see hold each one.'}
      />
      {msg && <div className="px-4 pb-3"><Alert tone={msg.tone}>{msg.text}</Alert></div>}
      {canManage && (
        <form
          className="flex flex-wrap items-end gap-2 px-4 pb-4"
          onSubmit={(e) => { e.preventDefault(); run(() => createSkillAction({ name: add.name, category: add.category || null }), () => setAdd({ name: '', category: '' })); }}
        >
          <Input aria-label="New skill name" className="!w-56" placeholder="New skill, e.g. Lean manufacturing" value={add.name} maxLength={60} onChange={(e) => setAdd({ ...add, name: e.target.value })} />
          <Input aria-label="New skill category" className="!w-44" placeholder="Category (optional)" list="skill-categories" value={add.category} maxLength={60} onChange={(e) => setAdd({ ...add, category: e.target.value })} />
          <Button type="submit" size="sm" variant="secondary" disabled={pending || add.name.trim().length < 2}><Plus className="size-3.5" /> Add skill</Button>
        </form>
      )}
      <datalist id="skill-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
      <div className="overflow-x-auto">
        <Table aria-label="Skills in this workspace">
          <THead><TR><TH>Skill</TH><TH>Category</TH><TH className="text-right">People</TH><TH className="text-right">Jobs</TH>{canManage && <TH>Merge into</TH>}{canManage && <TH><span className="sr-only">Actions</span></TH>}</TR></THead>
          <TBody>
            {skills.map((s) => {
              const v = value(s);
              return (
                <TR key={s.id}>
                  <TD>{canManage
                    ? <Input aria-label={`Name of ${s.name}`} className="!w-52" value={v.name} maxLength={60} onChange={(e) => setEdits({ ...edits, [s.id]: { ...v, name: e.target.value } })} />
                    : <span className="font-medium">{s.name}</span>}</TD>
                  <TD>{canManage
                    ? <Input aria-label={`Category of ${s.name}`} className="!w-40" list="skill-categories" value={v.category} maxLength={60} onChange={(e) => setEdits({ ...edits, [s.id]: { ...v, category: e.target.value } })} />
                    : s.category ? <Badge>{s.category}</Badge> : <span className="text-fg-subtle">—</span>}</TD>
                  <TD className="text-right tabular-nums">{s.people}</TD>
                  <TD className="text-right tabular-nums">{s.requisitions}</TD>
                  {canManage && (
                    <TD>
                      <div className="flex items-center gap-1">
                        <Select aria-label={`Merge ${s.name} into`} className="!w-44" value={into[s.id] ?? ''} onChange={(e) => setInto({ ...into, [s.id]: e.target.value })}>
                          <option value="">Choose a skill</option>
                          {skills.filter((o) => o.id !== s.id).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                        </Select>
                        <Button size="sm" variant="ghost" aria-label={`Merge ${s.name}`} disabled={pending || !into[s.id]} onClick={() => {
                          const target = skills.find((o) => o.id === into[s.id]);
                          if (target && confirm(`Merge “${s.name}” into “${target.name}”? ${s.people} holder(s) move over and “${s.name}” is removed.`)) run(() => mergeSkillAction(s.id, target.id));
                        }}><GitMerge className="size-3.5" /></Button>
                      </div>
                    </TD>
                  )}
                  {canManage && (
                    <TD>
                      <div className="flex items-center justify-end gap-1">
                        {changed(s) && (
                          <Button size="sm" aria-label={`Save ${s.name}`} disabled={pending} onClick={() => run(
                            () => updateSkillAction(s.id, { name: v.name.trim(), category: v.category.trim() || null }),
                            () => setEdits(({ [s.id]: _, ...rest }) => rest),
                          )}><Save className="size-3.5" /> Save</Button>
                        )}
                        <Button size="sm" variant="ghost" aria-label={`Remove ${s.name}`} disabled={pending} onClick={() => {
                          if (confirm(`Remove “${s.name}”? It is taken off ${s.people} person(s) and ${s.requisitions} job(s).`)) run(() => deleteSkillAction(s.id));
                        }}><Trash2 className="size-3.5" /></Button>
                      </div>
                    </TD>
                  )}
                </TR>
              );
            })}
          </TBody>
        </Table>
      </div>
      {!skills.length && <p className="px-4 pb-4 text-[0.8125rem] text-fg-subtle">No skills yet. They are added here or as people add them on profiles.</p>}
    </Card>
  );
}
