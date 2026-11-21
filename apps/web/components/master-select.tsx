'use client';
import { OTHER_OPTION, OTHER_OPTION_LABEL } from '@crew/contracts';
import { Input, Select } from '@crew/ui';
import { useEffect, useState } from 'react';
import { masterOptionsAction } from './master-data-actions';

/**
 * A dropdown filled from a master data list, with "Other / add new" at the end for a value the list does not have yet.
 * The chosen or typed label is sent under `name`, so it drops into an ordinary form.
 */
export function MasterSelect({ list, name, defaultValue, id, maxLength = 120, ...aria }: {
  list: string; name: string; defaultValue?: string | null; id?: string; maxLength?: number; 'aria-invalid'?: boolean; 'aria-describedby'?: string;
}) {
  const [options, setOptions] = useState<{ label: string; category: string | null }[] | null>(null);
  const [choice, setChoice] = useState(defaultValue ?? '');
  const [typed, setTyped] = useState('');
  useEffect(() => {
    let live = true;
    void masterOptionsAction(list).then((r) => {
      if (!live) return;
      const items = r.ok && r.data ? r.data : [];
      setOptions(items);
      // A value the list does not hold (typed before, or disabled since) shows as typed text.
      if (defaultValue && !items.some((o) => o.label === defaultValue)) { setChoice(OTHER_OPTION); setTyped(defaultValue); }
    });
    return () => { live = false; };
  }, [list, defaultValue]);
  const groups = [...new Set((options ?? []).map((o) => o.category ?? ''))];
  const value = choice === OTHER_OPTION ? typed.trim() : choice;
  return (
    <div className="grid gap-2">
      <input type="hidden" name={name} value={value} />
      <Select id={id} {...aria} value={choice} onChange={(e) => setChoice(e.target.value)} disabled={options === null} data-testid={`master-select-${name}`}>
        <option value="">{options === null ? 'Loading…' : 'Choose…'}</option>
        {groups.map((g) => {
          const items = (options ?? []).filter((o) => (o.category ?? '') === g).map((o) => <option key={o.label} value={o.label}>{o.label}</option>);
          return g ? <optgroup key={g} label={g}>{items}</optgroup> : items;
        })}
        <option value={OTHER_OPTION}>{OTHER_OPTION_LABEL}</option>
      </Select>
      {choice === OTHER_OPTION && <Input aria-label="Type the new value" placeholder="Type the new value" value={typed} maxLength={maxLength} autoFocus onChange={(e) => setTyped(e.target.value)} />}
    </div>
  );
}
