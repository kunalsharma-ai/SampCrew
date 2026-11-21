'use client';
import type { DocumentAccess } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardHeader, Checkbox } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveAccessAction } from '@/app/(app)/documents/actions';

export interface AccessScope {
  scope: string;
  name: string;
  hrWorkspaceId: string | null;
  people: number;
  switches: DocumentAccess;
  stored: Record<string, boolean> | null;
  sharedHrWorkspaceIds: string[];
  version: number;
  updatedAt: string | null;
}

export interface AccessSettings {
  switches: readonly { key: keyof DocumentAccess; label: string; description: string }[];
  scopes: AccessScope[];
}

/** One card per HR Workspace (and company-wide HR), each with its own switches and save. */
export function AccessEditor({ settings }: { settings: AccessSettings }) {
  const [current, setCurrent] = useState(settings.scopes[0]?.scope ?? 'central');
  const scope = settings.scopes.find((s) => s.scope === current) ?? settings.scopes[0];
  return (
    <div className="grid gap-5 lg:grid-cols-[16rem_1fr]">
      <nav aria-label="HR Workspaces" className="grid content-start gap-1">
        {settings.scopes.map((s) => (
          <button key={s.scope} type="button" onClick={() => setCurrent(s.scope)} aria-current={s.scope === current ? 'true' : undefined}
            className={`rounded-lg px-3 py-2 text-left text-sm ${s.scope === current ? 'bg-accent-subtle font-medium text-accent' : 'text-fg-muted hover:bg-bg-subtle'}`}>
            {s.name}
            <span className="block text-xs text-fg-subtle">{s.switches.enabled ? `${s.people} HR Workspace ${s.people === 1 ? 'person' : 'people'}` : 'Documents switched off'}</span>
          </button>
        ))}
      </nav>
      {scope && <ScopeEditor key={`${scope.scope}-${scope.version}`} scope={scope} settings={settings} />}
    </div>
  );
}

function ScopeEditor({ scope, settings }: { scope: AccessScope; settings: AccessSettings }) {
  const router = useRouter();
  const [values, setValues] = useState<DocumentAccess>(scope.stored ? { ...scope.switches, ...scope.stored, enabled: scope.stored.enabled ?? true } as DocumentAccess : scope.switches);
  const [shared, setShared] = useState<string[]>(scope.sharedHrWorkspaceIds);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const others = settings.scopes.filter((s) => s.hrWorkspaceId && s.scope !== scope.scope);
  const off = !values.enabled;

  const save = () => start(async () => {
    const r = await saveAccessAction(scope.scope, { switches: values, sharedHrWorkspaceIds: values.view_other_hr || values.request_other_hr ? shared : [], version: scope.version });
    setMsg({ ok: r.ok, text: r.ok ? r.message ?? 'Saved.' : r.message });
    if (r.ok) router.refresh();
  });

  return (
    <Card>
      <CardHeader title={scope.name} description={scope.hrWorkspaceId ? 'HR Workspace Admins of this HR Workspace work within these switches.' : 'HR Workspace people with company-wide access (no single HR Workspace) work within these switches.'}
        action={scope.updatedAt ? <Badge tone="neutral">Changed {new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(scope.updatedAt))}</Badge> : <Badge tone="neutral">Default access</Badge>} />
      <div className="grid gap-4 px-5 pb-5">
        {msg && <Alert tone={msg.ok ? 'success' : 'danger'}>{msg.text}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          {settings.switches.map((sw) => (
            <Checkbox key={sw.key} label={sw.label} description={sw.description} checked={values[sw.key]} disabled={sw.key !== 'enabled' && off}
              data-testid={`access-${sw.key}`} onChange={(e) => setValues((v) => ({ ...v, [sw.key]: e.target.checked }))} />
          ))}
        </div>
        {(values.view_other_hr || values.request_other_hr) && !off && (
          <fieldset className="grid gap-2 rounded-lg border border-border p-4">
            <legend className="px-1 text-sm font-medium">Other HR Workspaces it may work with</legend>
            {others.length === 0 && <p className="text-sm text-fg-muted">There are no other HR Workspaces yet.</p>}
            {others.map((o) => (
              <Checkbox key={o.scope} label={o.name} checked={shared.includes(o.hrWorkspaceId!)}
                onChange={(e) => setShared((s) => (e.target.checked ? [...s, o.hrWorkspaceId!] : s.filter((x) => x !== o.hrWorkspaceId)))} />
            ))}
          </fieldset>
        )}
        <div><Button onClick={save} loading={pending} data-testid="access-save">Save access</Button></div>
      </div>
    </Card>
  );
}
