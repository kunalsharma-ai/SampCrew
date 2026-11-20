'use client';
import { ACCESS_LEVEL_LABEL, levelRoleKeyFor } from '@crew/contracts';
import { Alert, Button, Card, CardBody, CardHeader, Select } from '@crew/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { saveApprovalChainForAction } from '@/app/(app)/settings/approvals/actions';

const APPROVER_LEVELS = ['hr_workspace', 'super_workspace'] as const;
const levelName = (key: string | undefined) => ACCESS_LEVEL_LABEL[levelRoleKeyFor(key ?? '') as keyof typeof ACCESS_LEVEL_LABEL] ?? 'HR Workspace';

export interface ChainStep { type: string; role?: string }

/**
 * Edits the approval chain of one request type: up to five steps, each the person's manager, their manager's
 * manager, or a role whose access covers the record. Used on Approval settings and on each module's settings page.
 */
export function ApprovalChainEditor({ resourceType, title, description, steps: initial, fallbackRole, note }: {
  resourceType: string; title: string; description?: string; steps: ChainStep[]; fallbackRole: string; roles?: { key: string; name: string }[]; note?: string;
}) {
  const [steps, setSteps] = useState<ChainStep[]>(initial.length ? initial : [{ type: 'manager' }]);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const label = (s: ChainStep) => (s.type === 'manager' ? 'their manager' : s.type === 'skip_level_manager' ? "their manager's manager" : `everyone with ${levelName(s.role)} access who covers it`);
  return (
    <Card data-testid={`chain-${resourceType}`}>
      <CardHeader title={title} description={description ?? `Steps run in order. Nobody approves their own request; if nobody can, it goes to everyone with ${levelName(fallbackRole)} access, then to Super Workspace.`} />
      <CardBody className="grid gap-3">
        <ol className="grid gap-2">
          {steps.map((s, i) => (
            <li key={i} className="flex items-center gap-2 text-sm">
              <span className="flex size-6 items-center justify-center rounded-full bg-accent-subtle text-xs font-semibold text-accent">{i + 1}</span>
              <Select aria-label={`${title}: step ${i + 1}`} value={s.type === 'role' ? `role:${levelRoleKeyFor(s.role ?? '')}` : s.type} className="max-w-md" onChange={(e) => {
                const v = e.target.value;
                const next = [...steps];
                next[i] = v.startsWith('role:') ? { type: 'role', role: v.slice(5) } : { type: v };
                setSteps(next);
              }}>
                <option value="manager">Their manager</option>
                <option value="skip_level_manager">Their manager&apos;s manager</option>
                {APPROVER_LEVELS.map((k) => <option key={k} value={`role:${k}`}>Everyone with {ACCESS_LEVEL_LABEL[k]} access</option>)}
              </Select>
              {steps.length > 1 && <button type="button" className="text-fg-subtle hover:text-danger" aria-label={`Remove step ${i + 1}`} onClick={() => setSteps(steps.filter((_, j) => j !== i))}><Trash2 className="size-4" /></button>}
            </li>
          ))}
        </ol>
        <p className="text-xs text-fg-subtle">First {steps.map(label).join(', then ')}.</p>
        {note && <p className="text-xs text-fg-muted">{note}</p>}
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <div className="flex gap-2">
          {steps.length < 5 && <Button size="sm" variant="secondary" onClick={() => setSteps([...steps, { type: 'role', role: 'hr_workspace' }])}><Plus className="size-3.5" /> Add step</Button>}
          <Button size="sm" loading={pending} onClick={() => start(async () => {
            const r = await saveApprovalChainForAction(resourceType, steps);
            setMsg(r.ok ? { tone: 'success', text: 'Approval chain saved. New requests follow it; requests already waiting keep their chain.' } : { tone: 'danger', text: r.message });
          })}>Save chain</Button>
        </div>
      </CardBody>
    </Card>
  );
}
