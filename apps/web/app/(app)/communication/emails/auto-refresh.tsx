'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Reloads the page's data every few seconds while something is still in progress (an email being sent). */
export function AutoRefresh({ active, every = 4000 }: { active: boolean; every?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), every);
    return () => clearInterval(t);
  }, [active, every, router]);
  return null;
}
