'use client';
import type { FormKey, ResolvedFormField } from '@crew/contracts';
import { useEffect, useState } from 'react';
import { formViewAction } from '@/app/(app)/custom-field-actions';

export interface FormRules {
  /** Whether the field shows (true until the rules are loaded, and for fields the form does not know). */
  show: (key: string) => boolean;
  required: (key: string) => boolean;
  label: (key: string, builtIn: string) => string;
  hint: (key: string, builtIn?: string) => string | undefined;
  placeholder: (key: string, builtIn?: string) => string | undefined;
  rules: ResolvedFormField[];
}

export function rulesOf(resolved: ResolvedFormField[]): FormRules {
  const by = new Map(resolved.map((r) => [r.key, r]));
  return {
    show: (k) => by.get(k)?.visible ?? true,
    required: (k) => by.get(k)?.required ?? false,
    label: (k, b) => { const r = by.get(k); return r && r.label !== r.builtInLabel ? r.label : b; },
    hint: (k, b) => by.get(k)?.hint ?? b,
    placeholder: (k, b) => by.get(k)?.placeholder || b,
    rules: resolved,
  };
}

/**
 * A form's rules from Form management (issue #91), loaded once the form is on screen. Until they arrive the form
 * shows its built-in fields as before, so nothing is lost if the rules cannot be read.
 */
export function useFormRules(key: FormKey): FormRules {
  const [resolved, setResolved] = useState<ResolvedFormField[]>([]);
  useEffect(() => {
    let live = true;
    void formViewAction(key).then((r) => { if (live && r.ok && r.data) setResolved(r.data.resolved); });
    return () => { live = false; };
  }, [key]);
  return rulesOf(resolved);
}
