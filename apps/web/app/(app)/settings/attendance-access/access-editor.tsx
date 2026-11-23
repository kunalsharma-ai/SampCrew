'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Switch } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useMfaRetry } from '@/components/mfa-step-up';
import { saveEmployeeAttendanceAccess, saveHrAttendanceAccess } from './actions';

interface Permission { key: string; label: string; description: string; locked: boolean; enabled: boolean }
interface HrRow { id: string; name: string; code: string | null; status: string; permissions: Permission[]; otherHrWorkspaceIds: string[] | null; updatedAt: string | null }
export interface AccessSettings { hrWorkspaces: HrRow[]; employeeWorkspace: Permission[] }

function HrWorkspaceCard({ row, all }: { row: HrRow; all: HrRow[] }) {
  const router = useRouter();
  const withMfa = useMfaRetry();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [perms, setPerms] = useState<Record<string, boolean>>(Object.fromEntries(row.permissions.map((p) => [p.key, p.enabled])));
  const [allOthers, setAllOthers] = useState(row.otherHrWorkspaceIds === null);
  const [others, setOthers] = useState<string[]>(row.otherHrWorkspaceIds ?? []);
  const choices = all.filter((w) => w.id !== row.id);
  const save = () => start(async () => {
    setNotice(null);
    const editable = Object.fromEntries(row.permissions.filter((p) => !p.locked).map((p) => [p.key, perms[p.key]!]));
    const r = await withMfa(() => saveHrAttendanceAccess({ hrWorkspaceId: row.id, permissions: editable, otherHrWorkspaceIds: allOthers ? null : others }));
    setNotice(r.ok ? { tone: 'success', text: 'Saved. It applies from the next page they open.' } : { tone: 'danger', text: r.message });
    if (r.ok) router.refresh();
  });
  const viewOther = perms['attendance.view_other_hr'];
  return (
    <Card data-testid={`access-${row.id}`}>
      <CardHeader
        title={row.name}
        description={row.id === 'central' ? 'HR people who look after the whole company (not limited to one HR Workspace).' : `${row.code ? `${row.code} · ` : ''}${row.status === 'active' ? 'Active' : 'Suspended'} HR Workspace`}
        action={viewOther ? <Badge tone="warning">Sees other HR Workspaces</Badge> : <Badge>Own employees only</Badge>}
      />
      <CardBody className="grid gap-4">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        <ul className="grid gap-3">
          {row.permissions.map((p) => (
            <li key={p.key} className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-medium text-fg">{p.label}{p.locked && <span className="ml-2 text-xs font-normal text-fg-subtle">Always on</span>}</div>
                <div className="text-xs text-fg-muted">{p.description}</div>
              </div>
              <Switch checked={perms[p.key]!} disabled={p.locked || pending} label={`${p.label} for ${row.name}`} testId={`${row.id}-${p.key}`}
                onChange={(v) => setPerms((x) => ({ ...x, [p.key]: v }))} />
            </li>
          ))}
        </ul>
        {viewOther && (
          <fieldset className="grid gap-2 rounded-lg border border-border p-3">
            <legend className="px-1 text-sm font-medium">Which other HR Workspaces</legend>
            <label className="flex items-center gap-2 text-sm"><input type="radio" name={`scope-${row.id}`} checked={allOthers} onChange={() => setAllOthers(true)} /> All HR Workspaces, now and later</label>
            <label className="flex items-center gap-2 text-sm"><input type="radio" name={`scope-${row.id}`} checked={!allOthers} onChange={() => setAllOthers(false)} /> Only the ones I pick</label>
            {!allOthers && (
              <div className="grid gap-1 pl-6 sm:grid-cols-2">
                {choices.map((w) => (
                  <label key={w.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={others.includes(w.id)} onChange={(e) => setOthers((x) => (e.target.checked ? [...x, w.id] : x.filter((y) => y !== w.id)))} />
                    {w.name}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        )}
        <div><Button onClick={save} loading={pending} data-testid={`save-${row.id}`}>Save</Button></div>
      </CardBody>
    </Card>
  );
}

function EmployeeCard({ perms: initial }: { perms: Permission[] }) {
  const router = useRouter();
  const withMfa = useMfaRetry();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [perms, setPerms] = useState<Record<string, boolean>>(Object.fromEntries(initial.map((p) => [p.key, p.enabled])));
  const save = () => start(async () => {
    const r = await withMfa(() => saveEmployeeAttendanceAccess(perms));
    setNotice(r.ok ? { tone: 'success', text: 'Saved.' } : { tone: 'danger', text: r.message });
    if (r.ok) router.refresh();
  });
  return (
    <Card data-testid="access-employee-workspace">
      <CardHeader title="Employee Workspace" description="Every employee sees only their own attendance. This cannot be widened." />
      <CardBody className="grid gap-4">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        {initial.map((p) => (
          <div key={p.key} className="flex items-start justify-between gap-4">
            <div><div className="text-sm font-medium text-fg">{p.label}</div><div className="text-xs text-fg-muted">{p.description}</div></div>
            <Switch checked={perms[p.key]!} disabled={pending} label={p.label} testId={`employee-${p.key}`} onChange={(v) => setPerms((x) => ({ ...x, [p.key]: v }))} />
          </div>
        ))}
        <div><Button onClick={save} loading={pending} data-testid="save-employee-workspace">Save</Button></div>
      </CardBody>
    </Card>
  );
}

export function AccessEditor({ data }: { data: AccessSettings }) {
  return (
    <div className="grid gap-6">
      <div className="grid gap-4 lg:grid-cols-2">
        {data.hrWorkspaces.map((row) => <HrWorkspaceCard key={row.id} row={row} all={data.hrWorkspaces} />)}
      </div>
      <EmployeeCard perms={data.employeeWorkspace} />
    </div>
  );
}
