'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Field, Select } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveSessionPolicyAction } from '../actions';

export interface SessionPolicy { idleMinutes: number; label: string; choices: { minutes: number; label: string }[]; canChange: boolean }

/** Automatic sign-out after inactivity, for everyone in the company. Only the Super Workspace changes it (issue #89). */
export function SessionPolicyCard({ policy }: { policy: SessionPolicy }) {
  const router = useRouter();
  const [value, setValue] = useState(policy.idleMinutes);
  const [result, setResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card data-testid="session-policy">
      <CardHeader title="Automatic sign-out" description="Signs out every Super Workspace, HR Workspace and Employee Workspace user after this long without using SampCrew, on the web and on the phone." />
      <CardBody className="grid gap-3">
        {policy.canChange ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              start(async () => {
                const r = await saveSessionPolicyAction(value);
                setResult(r.ok ? { ok: true, message: 'Saved. It applies to everyone from their next click.' } : { ok: false, message: r.message });
                if (r.ok) router.refresh();
              });
            }}
          >
            <Field label="Sign people out" className="min-w-64">
              {(p) => (
                <Select {...p} name="idleMinutes" value={value} onChange={(e) => setValue(Number(e.target.value))}>
                  {policy.choices.map((c) => <option key={c.minutes} value={c.minutes}>{c.label}</option>)}
                </Select>
              )}
            </Field>
            <Button type="submit" disabled={pending || value === policy.idleMinutes}>Save</Button>
          </form>
        ) : (
          <p className="flex flex-wrap items-center gap-2 text-sm"><Badge>{policy.label}</Badge><span className="text-fg-muted">Set by your Super Workspace.</span></p>
        )}
        {result && <Alert tone={result.ok ? 'success' : 'danger'}>{result.message}</Alert>}
      </CardBody>
    </Card>
  );
}
