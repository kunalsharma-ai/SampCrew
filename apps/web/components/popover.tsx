'use client';
import { cn } from '@crew/ui';
import { useEffect } from 'react';

/** A small panel under (or above) its button; closes on Escape or a click outside. */
export function Popover({ open, onClose, children, className, up }: { open: boolean; onClose: () => void; children: React.ReactNode; className?: string; up?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className={cn('absolute z-50 rounded-xl border border-border bg-surface-raised shadow-pop animate-fade-in', up ? 'bottom-full left-0 mb-2' : 'right-0 top-full mt-2', className)}>{children}</div>
    </>
  );
}
