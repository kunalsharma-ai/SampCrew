'use client';
import { Field, Input, Select } from '@crew/ui';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Targets } from '../documents/types';
import { AssignDialog } from './document-picker';

export function ListFilters({ status, q, pending }: { status: string; q: string; pending: boolean }) {
  const router = useRouter();
  const path = usePathname();
  const [text, setText] = useState(q);
  const go = (next: Record<string, string>) => {
    const p = new URLSearchParams({ status, ...(text ? { q: text } : {}), ...(pending ? { pending: 'true' } : {}), ...next });
    for (const [k, v] of [...p.entries()]) if (!v) p.delete(k);
    router.push(`${path}?${p}`);
  };
  return (
    <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); go({ q: text }); }}>
      <Field label="Search" className="w-64">{(p) => <Input {...p} placeholder="Name or employee code" value={text} onChange={(e) => setText(e.target.value)} />}</Field>
      <Field label="Show" className="w-48">{(p) => (
        <Select {...p} value={status} onChange={(e) => go({ status: e.target.value })}>
          <option value="active">In progress</option>
          <option value="completed">Completed (history)</option>
        </Select>
      )}</Field>
      <label className="flex items-center gap-2 pb-2 text-sm">
        <input type="checkbox" checked={pending} onChange={(e) => go({ pending: e.target.checked ? 'true' : '' })} data-testid="onboarding-pending-only" />
        Only with documents waiting for approval
      </label>
    </form>
  );
}

export function AssignToSomeone({ employees }: { employees: Targets['employees'] }) {
  const [id, setId] = useState('');
  if (!employees.length) return null;
  return (
    <span className="flex items-center gap-2">
      <Select aria-label="Employee to assign documents to" value={id} onChange={(e) => setId(e.target.value)} className="w-56" data-testid="onboarding-assign-employee">
        <option value="">Choose an employee…</option>
        {employees.map((e) => <option key={e.id} value={e.id}>{e.name}{e.code ? ` (${e.code})` : ''}</option>)}
      </Select>
      {id && <AssignDialog key={id} employeeId={id} />}
    </span>
  );
}
