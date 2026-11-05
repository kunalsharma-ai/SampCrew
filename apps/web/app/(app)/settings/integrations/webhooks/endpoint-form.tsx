'use client';
import { Alert, Checkbox, Field, Input } from '@crew/ui';
import type { WebhookEventDef } from '../types';

export interface EndpointDraft { name: string; url: string; events: string[] }

export const endpointValid = (d: EndpointDraft) => d.name.trim().length >= 3 && /^https?:\/\/\S+$/.test(d.url.trim()) && d.events.length > 0;

/** Name, address and event checkboxes, grouped as in the event catalogue. */
export function EndpointFields({ draft, onChange, events, error }: { draft: EndpointDraft; onChange: (d: EndpointDraft) => void; events: WebhookEventDef[]; error?: string | null }) {
  const groups = [...new Set(events.map((e) => e.group))];
  return (
    <div className="grid gap-4">
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Name" required>{(p) => <Input {...p} value={draft.name} maxLength={80} onChange={(e) => onChange({ ...draft, name: e.target.value })} placeholder="e.g. Finance data warehouse" />}</Field>
      <Field label="Address" required hint="An https:// address on the public internet. Private and local network addresses are refused.">
        {(p) => <Input {...p} value={draft.url} maxLength={2000} onChange={(e) => onChange({ ...draft, url: e.target.value })} placeholder="https://example.com/crew-events" />}
      </Field>
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-[0.8125rem] font-medium">Events to send</legend>
        {groups.map((g) => (
          <div key={g}>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-fg-subtle">{g}</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {events.filter((e) => e.group === g).map((e) => (
                <Checkbox
                  key={e.type}
                  label={e.label}
                  description={<span className="font-mono text-[0.6875rem]">{e.type} · sends {e.dataKeys.join(', ')}</span>}
                  checked={draft.events.includes(e.type)}
                  onChange={(x) => onChange({ ...draft, events: x.target.checked ? [...draft.events, e.type] : draft.events.filter((t) => t !== e.type) })}
                />
              ))}
            </div>
          </div>
        ))}
      </fieldset>
    </div>
  );
}
