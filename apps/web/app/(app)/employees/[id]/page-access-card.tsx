'use client';
import { PAGE_ACCESS_CHOICES, type PageAccessView } from '@crew/contracts';
import { Alert, Button, Card, CardBody, CardHeader, Checkbox } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { savePageAccessAction } from '../actions';

/** The everyday pages this person's login opens (issue #86), first chosen at registration. */
export function PageAccessCard({ employeeId, view }: { employeeId: string; view: PageAccessView }) {
  const router = useRouter();
  const [pages, setPages] = useState<string[]>(view.pages ?? []);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  if (!view.pages) return null;
  const dirty = [...pages].sort().join() !== [...view.pages].sort().join();
  const save = () => start(async () => {
    const r = await savePageAccessAction(employeeId, pages);
    if (!r.ok) { setError(r.message); return; }
    setError(null); setSaved(true); router.refresh();
  });
  return (
    <Card data-testid="page-access-card">
      <CardHeader title="Page access" description="The everyday pages their login opens. Home, profile, tasks and help are always there." />
      <CardBody className="space-y-3 pt-0">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid gap-2 sm:grid-cols-2">
          {PAGE_ACCESS_CHOICES.map((c) => (
            <Checkbox key={c.key} label={c.label} checked={pages.includes(c.key)} disabled={!view.canEdit || pending} data-testid={`page-access-${c.key}`}
              onChange={(ev) => { const on = ev.currentTarget.checked; setSaved(false); setPages((x) => on ? [...new Set([...x, c.key])] : x.filter((k) => k !== c.key)); }} />
          ))}
        </div>
        {view.canEdit && (
          <div className="flex items-center justify-end gap-2">
            {saved && !dirty && <span className="text-xs text-success">Saved</span>}
            <Button size="sm" onClick={save} disabled={!dirty} loading={pending} data-testid="page-access-save">Save page access</Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
