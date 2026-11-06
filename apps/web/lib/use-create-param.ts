'use client';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * Open-state for a "create" dialog that the Create menu, command palette and SampCrew IQ can open with ?create=<key>.
 * `prefill` names other parameters to hand to the form as starting values (for example ?title=...). The parameters
 * are removed once read, so a refresh or the back button does not reopen the dialog. The search params come from the
 * router, so this also works after a client-side navigation from another page.
 */
export function useCreateParam(key: string, prefill: readonly string[] = []) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const search = useSearchParams();
  const wanted = search.get('create') === key;
  const names = prefill.join(',');
  useEffect(() => {
    if (!wanted) return;
    const url = new URL(window.location.href);
    const found: Record<string, string> = {};
    for (const n of names ? names.split(',') : []) {
      const v = search.get(n);
      if (v) found[n] = v.slice(0, 5000);
      url.searchParams.delete(n);
    }
    setValues(found);
    setOpen(true);
    url.searchParams.delete('create');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }, [wanted, key, names, search]);
  return [open, setOpen, values] as const;
}
