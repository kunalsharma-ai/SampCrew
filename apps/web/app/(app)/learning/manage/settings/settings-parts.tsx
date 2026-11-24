'use client';
import { LEARNING_CAP_LABEL, LEARNING_CAPS, type LearningCap } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Input, Switch, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useRunner } from '../../../recruitment/use-runner';
import { addCategoryAction, removeCategoryAction, setLearningPermissionsAction } from '../../actions';
import type { PermissionRow } from '../../types';

export function PermissionsGrid({ rows }: { rows: PermissionRow[] }) {
  const { pending, notice, run } = useRunner();
  const toggle = (r: PermissionRow, cap: LearningCap, on: boolean) => {
    let caps = on ? [...new Set([...r.caps, cap])] : r.caps.filter((c) => c !== cap);
    // Without viewing, nothing else works.
    if (cap === 'view' && !on) caps = [];
    run(() => setLearningPermissionsAction(r.hrWorkspaceId, caps));
  };
  return (
    <Card>
      <CardHeader title="What each HR Workspace can do in Learning" description="Everything except viewing is off until you switch it on. HR Workspaces only ever reach the people they look after. Turning on any power turns on viewing too." />
      {notice && <div className="px-5 pb-3"><Alert tone={notice.tone}>{notice.text}</Alert></div>}
      <div className="overflow-x-auto">
        <Table aria-label="Learning powers by HR Workspace">
          <THead>
            <TR>
              <TH>HR Workspace</TH>
              {LEARNING_CAPS.map((c) => <TH key={c} className="whitespace-normal text-center text-[0.6875rem] leading-tight">{LEARNING_CAP_LABEL[c]}</TH>)}
            </TR>
          </THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.hrWorkspaceId ?? 'central'} data-testid={`permissions-${r.name}`}>
                <TD><span className="font-medium">{r.name}</span><span className="block text-xs text-fg-muted">{r.employees} employee{r.employees === 1 ? '' : 's'}{r.customised ? '' : ' · default'}</span></TD>
                {LEARNING_CAPS.map((c) => (
                  <TD key={c} className="text-center">
                    <Switch checked={r.caps.includes(c)} disabled={pending} onChange={(v) => toggle(r, c, v)} label={`${LEARNING_CAP_LABEL[c]} for ${r.name}`} testId={`cap-${r.hrWorkspaceId ?? 'central'}-${c}`} />
                  </TD>
                ))}
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
    </Card>
  );
}

export function CategoriesCard({ predefined, custom }: { predefined: string[]; custom: { id: string; name: string }[] }) {
  const { pending, notice, run } = useRunner();
  const [name, setName] = useState('');
  return (
    <Card>
      <CardHeader title="Learning categories" description="The built-in categories are always available. Add your own; removing one keeps it on the modules that use it." />
      <CardBody className="grid gap-4">
        <div className="flex flex-wrap gap-1.5">{predefined.map((c) => <Badge key={c} tone="neutral">{c}</Badge>)}</div>
        <div className="flex flex-wrap gap-1.5">
          {custom.map((c) => <Badge key={c.id} tone="info">{c.name}<button data-delete-area="learning" data-delete={`category ${c.name}`} type="button" aria-label={`Remove ${c.name}`} disabled={pending} onClick={() => run(() => removeCategoryAction(c.id))}><X className="size-3" /></button></Badge>)}
          {!custom.length && <span className="text-xs text-fg-muted">No custom categories yet.</span>}
        </div>
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) run(() => addCategoryAction(name.trim()), () => setName('')); }}>
          <Input aria-label="New category" value={name} onChange={(e) => setName(e.target.value)} placeholder="For example, Warehouse Operations" maxLength={60} className="max-w-72" />
          <Button type="submit" size="sm" variant="secondary" loading={pending} disabled={!name.trim()}><Plus className="size-4" aria-hidden />Add category</Button>
        </form>
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      </CardBody>
    </Card>
  );
}
