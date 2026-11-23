'use client';
import { Badge, Input, cn } from '@crew/ui';
import { X } from 'lucide-react';
import { useState } from 'react';

export interface Named { id: string; name: string }
export interface LeaveOptions {
  level: 'super' | 'hr';
  departments: Named[];
  designations: Named[];
  locations: Named[];
  legalEntities: Named[];
  groups: Named[];
  hrWorkspaces: Named[];
  companyHr: boolean;
  superAdmins: Named[];
  employees: { id: string; name: string; code: string; departmentId: string | null; designationId: string | null; hrWorkspaceId: string | null; employmentType: string | null }[];
}

/** A list to pick several from, as toggle chips, with a search box when it is long. */
export function ChipPicker({ label, all, chosen, onChange, testId, hint }: { label: string; all: Named[]; chosen: string[]; onChange: (ids: string[]) => void; testId?: string; hint?: string }) {
  const [q, setQ] = useState('');
  const shown = all.filter((x) => !q || x.name.toLowerCase().includes(q.toLowerCase())).slice(0, 40);
  const toggle = (id: string) => onChange(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
  return (
    <fieldset className="grid gap-1.5" data-testid={testId}>
      <legend className="mb-1 flex w-full items-center justify-between gap-2 text-xs font-medium text-fg">
        <span>{label}{chosen.length > 0 && <span className="ml-1 text-fg-subtle">({chosen.length} chosen)</span>}</span>
        {all.length > 8 && <Input aria-label={`Find ${label.toLowerCase()}`} placeholder="Find" value={q} onChange={(e) => setQ(e.target.value)} className="h-7 w-32 text-xs" />}
      </legend>
      {hint && <p className="text-xs text-fg-subtle">{hint}</p>}
      {all.length === 0 ? <p className="text-xs text-fg-subtle">None set up yet.</p> : (
        <div className="flex flex-wrap gap-1.5">
          {shown.map((x) => (
            <button key={x.id} type="button" aria-pressed={chosen.includes(x.id)} onClick={() => toggle(x.id)}
              className={cn('min-h-8 rounded-full border px-2.5 py-1 text-xs', chosen.includes(x.id) ? 'border-accent bg-accent text-accent-fg' : 'border-border text-fg-muted hover:text-fg')}>
              {x.name}
            </button>
          ))}
          {all.length > shown.length && <span className="self-center text-xs text-fg-subtle">{all.length - shown.length} more: search to find them</span>}
        </div>
      )}
    </fieldset>
  );
}

/** Named people, found by name or employee code. */
export function PeoplePicker({ label, people, chosen, onChange, testId }: { label: string; people: LeaveOptions['employees']; chosen: string[]; onChange: (ids: string[]) => void; testId?: string }) {
  const [q, setQ] = useState('');
  const byId = new Map(people.map((p) => [p.id, p]));
  const term = q.trim().toLowerCase();
  const found = term.length < 1 ? [] : people.filter((p) => !chosen.includes(p.id) && (p.name.toLowerCase().includes(term) || p.code.toLowerCase().includes(term))).slice(0, 8);
  return (
    <div className="grid gap-1.5" data-testid={testId}>
      <span className="text-xs font-medium">{label}{chosen.length > 0 && <span className="ml-1 text-fg-subtle">({chosen.length} chosen)</span>}</span>
      {chosen.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {chosen.map((id) => (
            <Badge key={id}>{byId.get(id)?.name ?? 'Chosen person'}
              <button type="button" className="ml-1" aria-label={`Remove ${byId.get(id)?.name ?? 'person'}`} onClick={() => onChange(chosen.filter((x) => x !== id))}><X className="size-3" /></button>
            </Badge>
          ))}
        </div>
      )}
      <Input aria-label={`Find ${label.toLowerCase()}`} placeholder="Type a name or employee code" value={q} onChange={(e) => setQ(e.target.value)} />
      {found.length > 0 && (
        <ul className="grid gap-1 rounded-lg border border-border p-1">
          {found.map((p) => (
            <li key={p.id}>
              <button type="button" className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-bg-subtle" onClick={() => { onChange([...chosen, p.id]); setQ(''); }}>
                {p.name} <span className="text-xs text-fg-subtle">{p.code}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

