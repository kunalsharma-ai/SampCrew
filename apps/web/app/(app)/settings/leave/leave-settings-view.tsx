'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Input, Select } from '@crew/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { type FieldDef, ResourceDialog } from '@/components/resource-form';
import type { ActionResult } from '@/lib/api';
import type { HolidayCalendar, LegalEntity, Location } from '@/lib/types';
import { addHolidayAction, deleteCalendarAction, removeHolidayAction, saveCalendarAction } from './actions';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const yesNo = [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }];

interface Props {
  calendars: HolidayCalendar[];
  entities: LegalEntity[];
  locations: Location[];
}

export function LeaveSettingsView(props: Props) {
  const router = useRouter();
  const [, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const run = (fn: () => Promise<ActionResult<unknown>>, ok?: (data: unknown) => string) => start(async () => {
    const r = await fn();
    setNotice(r.ok ? { tone: 'success', text: ok ? ok(r.data) : r.message ?? 'Saved' } : { tone: 'danger', text: r.message });
    if (r.ok) router.refresh();
  });
  return (
    <div className="grid gap-6">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Alert tone="info">
        Leave types, who sees them and the quantities people have are on <a className="font-medium underline" href="/leave/manage?tab=types">Leave management</a>.
      </Alert>
      <CalendarsCard {...props} run={run} />
    </div>
  );
}

type Run = (fn: () => Promise<ActionResult<unknown>>, ok?: (data: unknown) => string) => void;

function CalendarsCard({ calendars, entities, locations, run }: Props & { run: Run }) {
  const [editing, setEditing] = useState<HolidayCalendar | null | 'new'>(null);
  const current = editing && editing !== 'new' ? editing : null;
  const fields: FieldDef[] = [
    { name: 'name', label: 'Name', required: true },
    { name: 'legalEntityId', label: 'Legal entity', type: 'select', options: entities.map((e) => ({ value: e.id, label: e.name })), half: true },
    { name: 'locationId', label: 'Location', type: 'select', options: locations.map((l) => ({ value: l.id, label: l.name })), half: true, hint: 'A location calendar wins over an entity calendar' },
    { name: 'isDefault', label: 'Workspace default', type: 'select', required: true, options: yesNo, half: true },
    { name: 'weeklyOffs', label: 'Weekly offs', half: true, hint: 'Day numbers, 0 = Sunday. e.g. 0,6', placeholder: '0,6' },
  ];
  return (
    <Card>
      <CardHeader
        title="Holiday calendars"
        description="Leave days skip each calendar's weekly offs and holidays. Holidays are entered by you: SampCrew does not claim an official list for any country."
        action={<Button size="sm" onClick={() => setEditing('new')}><Plus className="size-3.5" /> Add calendar</Button>}
      />
      <CardBody className="grid gap-4">
        {calendars.map((c) => <CalendarBlock key={c.id} c={c} run={run} onEdit={() => setEditing(c)} />)}
      </CardBody>
      <ResourceDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={current ? `Edit ${current.name}` : 'Add calendar'}
        fields={fields}
        initial={current ? { ...current, isDefault: String(current.isDefault), weeklyOffs: current.weeklyOffs.join(',') } : { isDefault: 'false', weeklyOffs: '0,6' }}
        submitLabel="Save"
        onSubmit={(v) => saveCalendarAction(current?.id ?? null, {
          name: v.name, legalEntityId: v.legalEntityId ?? null, locationId: v.locationId ?? null, isDefault: v.isDefault === 'true',
          weeklyOffs: String(v.weeklyOffs ?? '').split(',').map((x) => x.trim()).filter(Boolean).map(Number),
        })}
      />
    </Card>
  );
}

function CalendarBlock({ c, run, onEdit }: { c: HolidayCalendar; run: Run; onEdit: () => void }) {
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [optional, setOptional] = useState('false');
  const year = new Date().getFullYear();
  const shown = c.holidays.filter((h) => Number(h.date.slice(0, 4)) >= year);
  return (
    <div className="rounded-lg border border-border">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="text-sm font-medium">{c.name}</span>
        {c.isDefault && <Badge tone="accent">Default</Badge>}
        <span className="text-xs text-fg-subtle">{c.locationName ?? c.legalEntityName ?? 'Workspace'} · off: {c.weeklyOffs.map((d) => DAYS[d]).join(', ') || 'none'}</span>
        <span className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" onClick={onEdit}>Edit</Button>
          {!c.isDefault && <Button data-delete-area="leave" data-delete={`holiday calendar ${c.name}`} size="sm" variant="ghost" onClick={() => confirm(`Delete ${c.name} and its holidays?`) && run(() => deleteCalendarAction(c.id))}>Delete</Button>}
        </span>
      </div>
      <ul className="divide-y divide-border">
        {shown.map((h) => (
          <li key={h.id} className="flex items-center gap-3 px-4 py-2 text-sm">
            <span className="w-28 tabular-nums text-fg-muted">{h.date}</span>
            <span className="flex-1">{h.name}{h.isOptional && <Badge className="ml-2">Optional</Badge>}</span>
            <button data-delete-area="leave" data-delete={`holiday ${h.name}`} className="text-fg-subtle hover:text-danger" aria-label={`Remove ${h.name}`} onClick={() => run(() => removeHolidayAction(c.id, h.id))}><Trash2 className="size-4" /></button>
          </li>
        ))}
        {!shown.length && <li className="px-4 py-3 text-sm text-fg-subtle">No upcoming holidays.</li>}
      </ul>
      <form
        className="flex flex-col gap-2 border-t border-border px-4 py-3 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => addHolidayAction(c.id, { date, name, isOptional: optional === 'true' }));
          setName('');
        }}
      >
        <Input type="date" aria-label="Holiday date" value={date} onChange={(e) => setDate(e.target.value)} required className="sm:w-44" />
        <Input aria-label="Holiday name" placeholder="Holiday name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        <Select aria-label="Optional holiday" value={optional} onChange={(e) => setOptional(e.target.value)} className="sm:w-36"><option value="false">Closed</option><option value="true">Optional</option></Select>
        <Button type="submit" variant="secondary">Add</Button>
      </form>
    </div>
  );
}
