'use client';
import { Badge, Input, cn } from '@crew/ui';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { peopleAction } from './actions';
import type { Person } from './types';

function usePeople(q: string) {
  const [people, setPeople] = useState<Person[]>([]);
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      const r = await peopleAction(q);
      if (live && r.ok) setPeople(r.data!.items);
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  return people;
}

/** Search people in the workspace and pick one (single) or several. */
export function PeoplePicker({ selected, onToggle, single }: { selected: string[]; onToggle: (p: Person) => void; single?: boolean }) {
  const [q, setQ] = useState('');
  const people = usePeople(q);
  return (
    <div className="grid gap-2">
      <Input aria-label="Find people" placeholder="Name, email, employee ID, workspace or level" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border" data-testid="people-picker">
        {people.map((p) => (
          <li key={p.membershipId}>
            <button type="button" onClick={() => onToggle(p)} className={cn('flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[0.8125rem] hover:bg-bg-subtle', selected.includes(p.membershipId) && 'bg-accent-subtle/60')}>
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-1.5"><span className="font-medium">{p.name}</span><Badge tone={p.level === 'super' ? 'ember' : p.level === 'hr' ? 'info' : 'neutral'}>{p.levelLabel}</Badge></span>
                <span className="block truncate text-xs text-fg-muted" data-testid="person-identity">{[p.workspace, p.employeeCode && `Employee ID ${p.employeeCode}`, p.email].filter(Boolean).join(' · ')}</span>
                <span className="block truncate text-[0.6875rem] text-fg-subtle">{[p.designation, p.department].filter(Boolean).join(' · ') || 'No department'}</span>
              </span>
              {!single && selected.includes(p.membershipId) && <Check className="size-4 text-accent" />}
            </button>
          </li>
        ))}
        {!people.length && <li className="px-3 py-4 text-center text-xs text-fg-muted">Nobody found.</li>}
      </ul>
    </div>
  );
}

