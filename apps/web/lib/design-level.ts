'use client';
import type { DesignLevel } from '@crew/contracts';
import { useEffect, useState } from 'react';

/** The level design the page shows (data-level on <html>, set by the signed-in shell). */
export function useDesignLevel(): DesignLevel {
  const [level, setLevel] = useState<DesignLevel>('employee');
  useEffect(() => {
    const read = () => setLevel((document.documentElement.dataset.level as DesignLevel | undefined) ?? 'employee');
    read();
    const o = new MutationObserver(read);
    o.observe(document.documentElement, { attributes: true, attributeFilter: ['data-level'] });
    return () => o.disconnect();
  }, []);
  return level;
}
