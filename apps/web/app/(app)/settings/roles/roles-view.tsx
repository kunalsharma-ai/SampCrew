'use client';
import { PERMISSIONS } from '@crew/contracts';
import { Badge, Card, CardHeader, cn } from '@crew/ui';
import { Lock } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Role } from '@/lib/types';

const SCOPE_LABEL: Record<string, string> = { own: 'Own', team: 'Team', department: 'Department', entity: 'Entity', tenant: 'All' };
const MODULES = [...new Set(PERMISSIONS.map((p) => p.module))];

/**
 * The four access categories: Console Admin runs SampCrew itself (in the Console); Super Workspace, HR Workspace and
 * Employee Workspace are given to people here. What each level may do is read-only here; limits for one person are set
 * under Logins & access, and SAMPLEDGE can switch permissions off for the whole workspace.
 */
export function RolesView({ roles, disabledPermissions = [] }: { roles: Role[]; disabledPermissions?: string[] }) {
  const off = useMemo(() => new Set(disabledPermissions), [disabledPermissions]);
  const [selectedId, setSelectedId] = useState(roles[0]?.id);
  const selected = roles.find((r) => r.id === selectedId) ?? roles[0];

  return (
    <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
      <Card className="h-fit">
        <CardHeader
          title="Access levels"
          description="Console Admin runs SampCrew itself from the Console. Each person here holds one of these."
        />
        <ul className="border-t border-border p-2">
          {roles.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => setSelectedId(r.id)}
                aria-current={selected?.id === r.id}
                className={cn('flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[0.8125rem]', selected?.id === r.id ? 'bg-accent-subtle text-accent' : 'hover:bg-bg-subtle')}
              >
                <Lock className="size-3.5 text-fg-subtle" aria-hidden />
                <span className="flex-1 font-medium">{r.name}</span>
                <span className="text-xs text-fg-subtle tabular">{r.memberCount}</span>
              </button>
            </li>
          ))}
        </ul>
      </Card>

      {selected && (
        <Card>
          <CardHeader
            title={selected.name}
            description={selected.description ?? undefined}
            action={<Badge>Access level</Badge>}
          />
          <div className="border-t border-border">
            {MODULES.map((m) => {
              const perms = PERMISSIONS.filter((p) => p.module === m);
              const granted = perms.filter((p) => selected.grants[p.key]);
              if (!granted.length) return null;
              return (
                <div key={m} className="border-b border-border px-5 py-3 last:border-0">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">{m}</div>
                  <ul className="grid gap-1.5">
                    {granted.map((p) => (
                      <li key={p.key} className="flex items-center justify-between gap-3 text-[0.8125rem]">
                        <span className={off.has(p.key) ? 'text-fg-subtle line-through' : undefined}>{p.description}{'requiresMfa' in p && p.requiresMfa && <Badge tone="warning" className="ml-2">MFA</Badge>}{off.has(p.key) && <Badge tone="danger" className="ml-2">Switched off by SAMPLEDGE</Badge>}</span>
                        <Badge tone="accent">{SCOPE_LABEL[selected.grants[p.key]!]}</Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            {!Object.keys(selected.grants).length && <p className="px-5 py-6 text-[0.8125rem] text-fg-muted">This level gives no permissions.</p>}
          </div>
        </Card>
      )}
    </div>
  );
}
