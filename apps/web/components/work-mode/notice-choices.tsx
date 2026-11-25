'use client';
import { Card, CardBody, CardHeader, Switch } from '@crew/ui';
import { useState, useTransition } from 'react';
import { saveNoticesAction } from '@/app/(app)/attendance/work-mode-actions';

/** Which attendance notices this person gets: check-in and check-out, changes, verification and missing check-outs. */
export function NoticeChoices({ notices }: { notices: { key: string; label: string; description: string; enabled: boolean }[] }) {
  const [state, setState] = useState(Object.fromEntries(notices.map((n) => [n.key, n.enabled])));
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();
  const toggle = (key: string, on: boolean) => {
    const before = state;
    setState({ ...state, [key]: on });
    start(async () => {
      const r = await saveNoticesAction({ [key]: on });
      if (!r.ok) { setState(before); setError(r.message); } else setError(null);
    });
  };
  return (
    <Card data-testid="attendance-notices">
      <CardHeader title="Attendance notices" description="Choose what you hear about. Notices arrive in the bell and update the page as they happen." />
      <CardBody className="grid gap-3 sm:grid-cols-2">
        {error && <p className="text-[0.8125rem] text-danger sm:col-span-2" role="alert">{error}</p>}
        {notices.map((n) => (
          <div key={n.key} className="flex items-start justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
            <div><div className="text-[0.8125rem] font-medium text-fg">{n.label}</div><div className="text-xs text-fg-muted">{n.description}</div></div>
            <Switch checked={Boolean(state[n.key])} onChange={(v) => toggle(n.key, v)} label={n.label} testId={`notice-${n.key}`} className="[&>span:last-child]:sr-only" />
          </div>
        ))}
      </CardBody>
    </Card>
  );
}
