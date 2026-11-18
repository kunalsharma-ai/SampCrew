'use client';
import { phoneError } from '@crew/contracts';
import { Alert, Button, Dialog, Field, Input, Select, Textarea } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { ActionResult } from '@/lib/api';

export interface FieldDef {
  name: string;
  label: string;
  /** 'tel' is checked as a phone number (the same rules as the API) before the form is sent. */
  type?: 'text' | 'number' | 'select' | 'textarea' | 'time' | 'date' | 'tel';
  options?: { value: string; label: string }[];
  required?: boolean;
  /** Empty value is sent as null (clears the field) instead of being omitted. */
  nullable?: boolean;
  hint?: string;
  placeholder?: string;
  half?: boolean;
  step?: string;
}

/** Dialog form driven by field definitions; posts through a server action and shows API validation errors inline. */
export function ResourceDialog({ open, onClose, title, description, fields, initial, submitLabel, onSubmit }: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  fields: FieldDef[];
  initial?: Record<string, unknown>;
  submitLabel: string;
  onSubmit: (values: Record<string, unknown>) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});

  return (
    <Dialog
      open={open}
      onClose={() => {
        setError(null);
        setFe({});
        onClose();
      }}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="resource-form" loading={pending}>{submitLabel}</Button>
        </>
      }
    >
      <form
        id="resource-form"
        className="grid grid-cols-2 gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const values: Record<string, unknown> = {};
          for (const def of fields) {
            const raw = String(f.get(def.name) ?? '').trim();
            if (raw === '') {
              if (def.nullable && initial) values[def.name] = null;
              continue;
            }
            values[def.name] = def.type === 'number' ? Number(raw) : raw;
          }
          setError(null);
          setFe({});
          const bad = Object.fromEntries(fields.filter((d) => d.type === 'tel').map((d) => [d.name, phoneError(String(values[d.name] ?? ''))]).filter((x): x is [string, string] => !!x[1]));
          if (Object.keys(bad).length) { setFe(bad); return; }
          start(async () => {
            const r = await onSubmit(values);
            if (r.ok) {
              onClose();
              router.refresh();
            } else {
              setError(r.message);
              setFe(r.fieldErrors ?? {});
            }
          });
        }}
      >
        {error && <Alert tone="danger" className="col-span-2">{error}</Alert>}
        {fields.map((def) => {
          const value = initial?.[def.name];
          const dv = value === null || value === undefined ? '' : String(value);
          return (
            <Field key={def.name} label={def.label} hint={def.hint} error={fe[def.name]} required={def.required} className={def.half ? 'col-span-2 sm:col-span-1' : 'col-span-2'}>
              {(p) =>
                def.type === 'select' ? (
                  <Select {...p} name={def.name} defaultValue={dv} required={def.required}>
                    {!def.required && <option value="">None</option>}
                    {def.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </Select>
                ) : def.type === 'textarea' ? (
                  <Textarea {...p} name={def.name} defaultValue={dv} placeholder={def.placeholder} />
                ) : def.type === 'tel' ? (
                  <Input {...p} name={def.name} type="tel" inputMode="tel" autoComplete="off" maxLength={40} defaultValue={dv} required={def.required} placeholder={def.placeholder ?? '+91 98201 23456'} />
                ) : (
                  <Input {...p} name={def.name} type={def.type === 'number' || def.type === 'time' || def.type === 'date' ? def.type : 'text'} step={def.step} defaultValue={dv} required={def.required} placeholder={def.placeholder} />
                )
              }
            </Field>
          );
        })}
      </form>
    </Dialog>
  );
}
