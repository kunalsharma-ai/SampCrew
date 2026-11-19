'use client';
import type { AudienceInput } from '@crew/contracts';
import { Badge, Checkbox, Input, cn } from '@crew/ui';
import { Users, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { peopleAction, previewAudienceAction } from '@/app/(app)/communication/actions';
import type { Person } from '@/app/(app)/communication/types';

export interface AudienceOptions {
  departments: { id: string; name: string }[];
  designations: { id: string; name: string }[];
  groups: { id: string; name: string; size: number }[];
}

type Named = { id: string; name: string };

function Chips({ label, all, chosen, onToggle, testId }: { label: string; all: Named[]; chosen: string[]; onToggle: (id: string) => void; testId: string }) {
  const [q, setQ] = useState('');
  if (!all.length) return null;
  const shown = all.filter((x) => !q || x.name.toLowerCase().includes(q.toLowerCase())).slice(0, 30);
  return (
    <fieldset className="grid gap-1.5" data-testid={testId}>
      <legend className="mb-1 flex w-full items-center justify-between text-xs font-medium">{label}{all.length > 8 && <Input aria-label={`Find ${label.toLowerCase()}`} placeholder="Find" value={q} onChange={(e) => setQ(e.target.value)} className="h-7 w-32 text-xs" />}</legend>
      <div className="flex flex-wrap gap-1.5">
        {shown.map((x) => (
          <button key={x.id} type="button" aria-pressed={chosen.includes(x.id)} onClick={() => onToggle(x.id)}
            className={cn('rounded-full border px-2.5 py-1 text-xs', chosen.includes(x.id) ? 'border-accent bg-accent text-accent-fg' : 'border-border text-fg-muted hover:text-fg')}>
            {x.name}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Who something is for: everyone, or any mix of departments (with their sub-departments), designations, HR's groups
 * and chosen people. Shows how many people it reaches now.
 */
export function AudiencePicker({ value, onChange, options, knownNames = {} }: { value: AudienceInput; onChange: (a: AudienceInput) => void; options: AudienceOptions; knownNames?: Record<string, string> }) {
  const [q, setQ] = useState('');
  const [people, setPeople] = useState<Person[]>([]);
  const [names, setNames] = useState<Record<string, string>>(knownNames);
  const [reach, setReach] = useState<{ count: number; sample: string[] } | null>(null);
  const toggle = (key: 'departmentIds' | 'designationIds' | 'groupIds' | 'membershipIds', id: string) =>
    onChange({ ...value, [key]: value[key].includes(id) ? value[key].filter((x) => x !== id) : [...value[key], id] });

  useEffect(() => {
    if (q.trim().length < 2) { setPeople([]); return; }
    let live = true;
    const t = setTimeout(async () => { const r = await peopleAction(q.trim()); if (live && r.ok) setPeople(r.data!.items.slice(0, 8)); }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  const key = JSON.stringify(value);
  useEffect(() => {
    const empty = !value.all && !value.departmentIds.length && !value.designationIds.length && !value.groupIds.length && !value.membershipIds.length;
    if (empty) { setReach({ count: 0, sample: [] }); return; }
    let live = true;
    const t = setTimeout(async () => { const r = await previewAudienceAction(value); if (live && r.ok) setReach(r.data!); }, 300);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <div className="grid gap-3 rounded-lg border border-border p-3" data-testid="audience-picker">
      <Checkbox label="Everyone in the workspace" checked={value.all} onChange={(e) => onChange({ ...value, all: e.target.checked })} />
      {!value.all && (
        <>
          <Chips label="Departments" all={options.departments} chosen={value.departmentIds} onToggle={(id) => toggle('departmentIds', id)} testId="audience-departments" />
          <Chips label="Designations" all={options.designations} chosen={value.designationIds} onToggle={(id) => toggle('designationIds', id)} testId="audience-designations" />
          <Chips label="Groups" all={options.groups.map((g) => ({ id: g.id, name: `${g.name} (${g.size})` }))} chosen={value.groupIds} onToggle={(id) => toggle('groupIds', id)} testId="audience-groups" />
          <div className="grid gap-1.5">
            <span className="text-xs font-medium">People</span>
            {value.membershipIds.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {value.membershipIds.map((id) => <Badge key={id}>{names[id] ?? 'Chosen person'} <button type="button" aria-label={`Remove ${names[id] ?? 'person'}`} onClick={() => toggle('membershipIds', id)}><X className="size-3" /></button></Badge>)}
              </div>
            )}
            <Input aria-label="Add people" placeholder="Type a name to add someone" value={q} onChange={(e) => setQ(e.target.value)} />
            {people.length > 0 && (
              <ul className="divide-y divide-border rounded-md border border-border" data-testid="audience-people">
                {people.map((p) => (
                  <li key={p.membershipId}>
                    <button type="button" className="w-full px-3 py-1.5 text-left text-[0.8125rem] hover:bg-bg-subtle" onClick={() => {
                      setNames((n) => ({ ...n, [p.membershipId]: p.name }));
                      if (!value.membershipIds.includes(p.membershipId)) toggle('membershipIds', p.membershipId);
                      setQ('');
                    }}>{p.name} <span className="text-xs text-fg-muted">{[p.designation, p.department].filter(Boolean).join(' · ')}</span></button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
      <p className="flex items-center gap-1.5 text-xs text-fg-muted" data-testid="audience-reach">
        <Users className="size-3.5" aria-hidden />
        {reach === null ? 'Counting…' : reach.count === 0 ? 'Nobody chosen yet' : `Reaches ${reach.count} ${reach.count === 1 ? 'person' : 'people'}${reach.sample.length ? `: ${reach.sample.slice(0, 4).join(', ')}${reach.count > 4 ? ' and others' : ''}` : ''}`}
      </p>
    </div>
  );
}
