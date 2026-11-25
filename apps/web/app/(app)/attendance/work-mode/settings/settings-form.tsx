'use client';
import { Alert, Button, Card, CardBody, CardHeader, Field, Input, Select } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { SwitchRow } from '@/components/work-mode/switch-row';
import { useState, useTransition } from 'react';
import type { WorkModeLabels } from '@/lib/types';
import { saveWorkModeSettingsAction } from '../../work-mode-actions';

export interface SettingsView {
  settings: { enabled: boolean; labels: WorkModeLabels; minOfficeMinutes: number; minRemoteMinutes: number; transition: 'split' | 'check_in' | 'check_out'; maxAccuracyM: number; otherOffices: string; officeRequirement: string; locationRetentionDays: number; employeeCanRequestCorrection: boolean; standardHours: number; classifyFrom: string };
  defaults: SettingsView['settings'];
  canConfigure: boolean;
  canRename: boolean;
}

export function WorkModeSettingsForm({ view }: { view: SettingsView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const { classifyFrom: _c, updatedAt: _u, ...initial } = view.settings as SettingsView['settings'] & { updatedAt?: unknown };
  const [f, setF] = useState(initial);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });
  const ro = !view.canConfigure;
  const save = () => start(async () => {
    setMsg(null);
    const { labels, ...rest } = f;
    const r = await saveWorkModeSettingsAction(view.canRename ? { ...rest, labels } : rest);
    setMsg(r.ok ? { tone: 'success', text: 'Saved. New and recalculated days use these rules.' } : { tone: 'danger', text: r.message });
    if (r.ok) router.refresh();
  });
  return (
    <div className="grid gap-6" data-testid="work-mode-settings">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {ro && <Alert tone="info">You can see these rules. Changing them needs attendance configuration access.</Alert>}
      <Card>
        <CardHeader title="Names" description={view.canRename ? 'What the three are called everywhere: dashboards, the employee view, reports and notices. The stored value never changes.' : 'Only the Super Workspace can rename these.'} />
        <CardBody className="grid gap-4 sm:grid-cols-3">
          {(['office', 'remote', 'hybrid'] as const).map((k) => (
            <Field key={k} label={k === 'office' ? 'At the office' : k === 'remote' ? 'Away from the office' : 'Both on one day'} hint={`Default: ${view.defaults.labels[k]}`}>
              {(p) => <Input {...p} value={f.labels[k]} maxLength={40} disabled={!view.canRename} onChange={(e) => set('labels', { ...f.labels, [k]: e.target.value })} data-testid={`label-${k}`} />}
            </Field>
          ))}
          {view.canRename && <div className="sm:col-span-3"><Button size="sm" variant="ghost" onClick={() => set('labels', view.defaults.labels)}>Use the default names</Button></div>}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Classification" />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><SwitchRow checked={f.enabled} onChange={(v) => set('enabled', v)} disabled={ro} label="Classify days as office, home or hybrid" /></div>
          <Field label="Minimum office time for hybrid (minutes)">{(p) => <Input {...p} type="number" min={0} max={720} value={f.minOfficeMinutes} disabled={ro} onChange={(e) => set('minOfficeMinutes', Number(e.target.value))} />}</Field>
          <Field label="Minimum time away for hybrid (minutes)">{(p) => <Input {...p} type="number" min={0} max={720} value={f.minRemoteMinutes} disabled={ro} onChange={(e) => set('minRemoteMinutes', Number(e.target.value))} />}</Field>
          <Field label="Time between a check-in and a check-out in different places" hint="With no location update in between, where was it worked?">{(p) => (
            <Select {...p} value={f.transition} disabled={ro} onChange={(e) => set('transition', e.target.value as 'split')}>
              <option value="split">Split half and half</option><option value="check_in">Where the check-in was</option><option value="check_out">Where the check-out was</option>
            </Select>
          )}</Field>
          <Field label="Other offices">{(p) => (
            <Select {...p} value={f.otherOffices} disabled={ro} onChange={(e) => set('otherOffices', e.target.value)}>
              <option value="office">Any company office counts as office</option><option value="remote">Only their own and assigned offices; other offices count as away</option>
            </Select>
          )}</Field>
          <Field label="Location accuracy needed (metres)" hint="Vaguer readings wait for verification unless clearly inside or outside.">{(p) => <Input {...p} type="number" min={10} max={5000} value={f.maxAccuracyM} disabled={ro} onChange={(e) => set('maxAccuracyM', Number(e.target.value))} />}</Field>
          <Field label="Standard working day (hours)">{(p) => <Input {...p} type="number" min={1} max={24} step={0.5} value={f.standardHours} disabled={ro} onChange={(e) => set('standardHours', Number(e.target.value))} />}</Field>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Office rule and corrections" />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label="Where people may check in" hint="Per-person rules on the Office locations page override this.">{(p) => (
            <Select {...p} value={f.officeRequirement} disabled={ro} onChange={(e) => set('officeRequirement', e.target.value)}>
              <option value="none">Anywhere (outside an office counts as home)</option><option value="check_in">Check-in must be at an office</option><option value="check_in_out">Check-in and check-out must be at an office</option>
            </Select>
          )}</Field>
          <div className="self-end"><SwitchRow checked={f.employeeCanRequestCorrection} onChange={(v) => set('employeeCanRequestCorrection', v)} disabled={ro} label="Employees may ask to change where a day counts" /></div>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Privacy" description="Locations are read only at check-in, check-out and when the person presses Update my location. They are never tracked continuously." />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label="Keep exact coordinates for (days)" hint="After this, coordinates are removed; the office or home result stays. 0 keeps them.">{(p) => <Input {...p} type="number" min={0} max={3650} value={f.locationRetentionDays} disabled={ro} onChange={(e) => set('locationRetentionDays', Number(e.target.value))} />}</Field>
          <p className="self-end text-[0.8125rem] text-fg-muted">Exact coordinates are shown only to the person themselves and to people with attendance configuration access. Days are classified from {view.settings.classifyFrom}.</p>
        </CardBody>
      </Card>
      {!ro && <div className="flex justify-end"><Button onClick={save} loading={pending} data-testid="save-work-mode-settings">Save rules</Button></div>}
    </div>
  );
}
