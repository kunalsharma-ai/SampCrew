'use client';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * Names for ids in the address, so the breadcrumb shows "Orbit Labs" instead of "Details". A page renders
 * <CrumbName id=… name=… /> and the shell's breadcrumb picks it up.
 */
const names = new Map<string, string>();
const subs = new Set<() => void>();
let version = 0;
const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; };

export function useCrumbNames(): [Map<string, string>, number] {
  const v = useSyncExternalStore(subscribe, () => version, () => 0);
  return [names, v];
}

export function CrumbName({ id, name }: { id: string; name: string }) {
  useEffect(() => {
    if (names.get(id) === name) return;
    names.set(id, name);
    version += 1;
    subs.forEach((fn) => fn());
  }, [id, name]);
  return null;
}
