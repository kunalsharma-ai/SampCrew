'use client';
import { useEffect, useState } from 'react';

/**
 * Open-state for a "create" dialog that the Create menu and command palette can open with ?create=<key>.
 * The parameter is removed once read, so a refresh or the back button does not reopen the dialog.
 */
export function useCreateParam(key: string) {
  const state = useState(false);
  const setOpen = state[1];
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('create') !== key) return;
    setOpen(true);
    url.searchParams.delete('create');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }, [key, setOpen]);
  return state;
}
