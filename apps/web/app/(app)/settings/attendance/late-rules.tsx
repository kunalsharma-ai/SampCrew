'use client';
import { Alert, Button, Card, CardBody, CardHeader, Field, Input, Select, Switch } from '@crew/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { DisciplinePolicy, LatePolicy, LateTier } from '@/lib/types';
import { saveLatePolicyAction } from '../../attendance/late/actions';
import { deduction } from '../../attendance/late/late-view';

/** Late-coming reminders (automatic and by hand) and the deduction tiers they lead to. */
export function LateRulesCard({ policy }: { policy: DisciplinePolicy }) {
  const router = useRouter();
  const [form, setForm] = useState<LatePolicy>(policy.late);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const set = (patch: Partial<LatePolicy>) => setForm({ ...form, ...patch });
  const setTier = (i: number, patch: Partial<LateTier>) => set({ tiers: form.tiers.map((t, n) => (n === i ? { ...t, ...patch } : t)) });
  const save = () => start(async () => {
    const r = await saveLatePolicyAction({ ...form, tiers: form.tiers.map((t) => ({ ...t, reminders: Number(t.reminders) })) });
    setNotice(r.ok ? { tone: 'success', text: r.message ?? 'Saved' } : { tone: 'danger', text: r.message });
    if (r.ok) router.refresh();
  });
  const toggle = (label: string, key: 'enabled' | 'autoReminders' | 'email' | 'notifyManager', hint: string) => (
    <label className="flex items-start gap-3">
      <Switch checked={form[key]} onChange={(v) => set({ [key]: v } as Partial<LatePolicy>)} label={label} testId={`late-${key}`} />
      <span className="grid text-[0.8125rem]"><span className="font-medium">{label}</span><span className="text-fg-subtle">{hint}</span></span>
    </label>
  );
  return (
    <Card>
      <CardHeader
        title="Late-coming reminders"
        description="Remind people who arrive after their shift start and grace time, in the app and by email, and deduct pay after a number of reminders in a month."
        action={<Button size="sm" loading={pending} onClick={save}>Save rules</Button>}
      />
      <CardBody className="grid gap-5">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          {toggle('Late-coming reminders on', 'enabled', 'Off: nothing is sent or deducted for late arrivals.')}
          {toggle('Send reminders automatically', 'autoReminders', 'As soon as attendance shows a late arrival. Off: managers send them from Late coming & penalties.')}
          {toggle('Email each reminder', 'email', 'Besides the notification on the dashboard and the mobile app.')}
          {toggle('Tell the manager', 'notifyManager', 'The person’s manager gets a notification for each reminder.')}
        </div>
        <Field label="Count arrivals late by at least (minutes)" hint="Minutes after the shift start, for arrivals already past the shift's grace time." className="max-w-xs">
          {(p) => <Input {...p} type="number" min={1} max={600} value={form.minLateMinutes} onChange={(e) => set({ minLateMinutes: Number(e.target.value) })} />}
        </Field>
        <div className="grid gap-3">
          <div className="text-sm font-medium">Salary deduction by reminders in a month</div>
          <p className="text-[0.8125rem] text-fg-subtle">The highest tier reached applies to the month; tiers do not add up. A percentage is of the month&apos;s gross pay; days are at monthly gross divided by the days in the month.</p>
          {form.tiers.map((t, i) => (
            <div key={i} className="flex flex-wrap items-end gap-3" data-testid="late-tier">
              <Field label="After reminders" className="w-36">{(p) => <Input {...p} type="number" min={1} max={31} value={t.reminders} onChange={(e) => setTier(i, { reminders: Number(e.target.value) })} />}</Field>
              <Field label="Deduct" className="w-48">
                {(p) => (
                  <Select {...p} value={t.basis} onChange={(e) => setTier(i, { basis: e.target.value as LateTier['basis'] })}>
                    <option value="percent">Percentage of gross pay</option>
                    <option value="days">Days of pay</option>
                  </Select>
                )}
              </Field>
              <Field label={t.basis === 'percent' ? 'Percent' : 'Days (0.5 steps)'} className="w-32">
                {(p) => <Input {...p} inputMode="decimal" value={t.value} onChange={(e) => setTier(i, { value: e.target.value })} />}
              </Field>
              <span className="pb-2 text-[0.8125rem] text-fg-muted">{t.reminders} reminders: {deduction(t)}</span>
              <Button variant="ghost" size="sm" aria-label={`Remove the tier at ${t.reminders} reminders`} onClick={() => set({ tiers: form.tiers.filter((_, n) => n !== i) })}><Trash2 className="size-3.5" /></Button>
            </div>
          ))}
          <div>
            <Button variant="secondary" size="sm" disabled={form.tiers.length >= 6} onClick={() => set({ tiers: [...form.tiers, { reminders: (form.tiers.at(-1)?.reminders ?? 2) + 2, basis: 'percent', value: '5' }] })}>
              <Plus className="size-3.5" /> Add a tier
            </Button>
          </div>
        </div>
        {policy.lateSince && policy.late.enabled && policy.late.autoReminders && <p className="text-xs text-fg-subtle">Automatic reminders are sent for days from {policy.lateSince}.</p>}
      </CardBody>
    </Card>
  );
}
