'use client';
import { Alert, Button, Card, CardBody, CardHeader, Checkbox, Field, Input, Select, Switch } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { DisciplinePolicy, LeaveType, SameDayLeavePolicy } from '@/lib/types';
import { saveSameDayPolicyAction } from '../../attendance/late/actions';

/** The penalty for leave applied on the day it starts: automatic, or left to the approving manager. */
export function SameDayRuleCard({ policy, types }: { policy: DisciplinePolicy; types: LeaveType[] }) {
  const router = useRouter();
  const [form, setForm] = useState<SameDayLeavePolicy>(policy.sameDayLeave);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const set = (patch: Partial<SameDayLeavePolicy>) => setForm({ ...form, ...patch });
  const save = () => start(async () => {
    const r = await saveSameDayPolicyAction(form);
    setNotice(r.ok ? { tone: 'success', text: r.message ?? 'Saved' } : { tone: 'danger', text: r.message });
    if (r.ok) router.refresh();
  });
  return (
    <Card>
      <CardHeader
        title="Same-day leave penalty"
        description="Leave applied on the day it starts (or later) can cost days of pay. The approving manager always sees it, and can apply, change or waive the penalty."
        action={<Button size="sm" loading={pending} onClick={save}>Save rule</Button>}
      />
      <CardBody className="grid gap-5">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        <label className="flex items-start gap-3">
          <Switch checked={form.enabled} onChange={(v) => set({ enabled: v })} label="Same-day leave penalty on" testId="same-day-enabled" />
          <span className="grid text-[0.8125rem]"><span className="font-medium">Same-day leave penalty on</span><span className="text-fg-subtle">Off: same-day leave is only marked for the approver.</span></span>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="How the penalty is applied">
            {(p) => (
              <Select {...p} value={form.mode} onChange={(e) => set({ mode: e.target.value as SameDayLeavePolicy['mode'] })}>
                <option value="auto">Automatically, when the leave is applied</option>
                <option value="manual">By the manager, when approving</option>
              </Select>
            )}
          </Field>
          <Field label="Penalty (days of pay)" hint="Whole or half days, for example 2 or 3.5. In manual mode this is the suggestion.">
            {(p) => <Input {...p} inputMode="decimal" value={form.penaltyDays} onChange={(e) => set({ penaltyDays: e.target.value })} />}
          </Field>
        </div>
        <Checkbox label="Count backdated leave too" description="Leave applied after the day it started is treated as same-day leave." checked={form.includeBackdated} onChange={(e) => set({ includeBackdated: e.target.checked })} />
        {types.length > 0 && (
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Leave types with no penalty</legend>
            {types.map((t) => (
              <Checkbox
                key={t.id}
                label={t.name}
                checked={form.exemptLeaveTypeIds.includes(t.id)}
                onChange={(e) => set({ exemptLeaveTypeIds: e.target.checked ? [...form.exemptLeaveTypeIds, t.id] : form.exemptLeaveTypeIds.filter((x) => x !== t.id) })}
              />
            ))}
          </fieldset>
        )}
      </CardBody>
    </Card>
  );
}
