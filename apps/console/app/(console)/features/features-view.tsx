'use client';
import { isFeatureAction, type PlatformFeatureRow } from '@crew/contracts';
import { Alert, Card, CardBody, FeatureSwitchBoard, Stat } from '@crew/ui';
import { useState, useTransition } from 'react';
import { setPlatformFeaturesAction } from './actions';

const COLUMN = [{ key: 'platform', label: 'Whole application', target: 'every company and every level' }];

/** Console > Feature management: one switch per module and page for the whole application. */
export function FeaturesView({ rows, counts, canEdit }: { rows: PlatformFeatureRow[]; counts: Record<string, number>; canEdit: boolean }) {
  const [list, setList] = useState(rows);
  const [tally, setTally] = useState(counts);
  const [flash, setFlash] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const change = (key: string, _column: string, on: boolean) => start(async () => {
    const name = list.find((r) => r.key === key)?.name ?? key;
    const res = await setPlatformFeaturesAction([{ key, state: on ? 'active' : 'off' }]);
    if (res.ok && res.data) {
      setList(res.data.items);
      setTally(res.data.counts);
    }
    setFlash({ tone: res.ok ? 'success' : 'danger', text: res.ok ? `${name}: ${res.message}` : res.message });
  });
  const board = list.map((r) => ({
    key: r.key, name: r.name, module: r.module, parent: r.parent, kind: isFeatureAction(r.key) ? ('action' as const) : ('page' as const), audience: r.audience,
    note: r.parent ? undefined : `${r.companies} ${r.companies === 1 ? 'company' : 'companies'} on a plan with it`,
    cells: {
      platform: r.core
        ? { on: true, indicator: 'active' as const, editable: false }
        : { on: r.state === 'active', indicator: r.state === 'active' ? ('active' as const) : r.state === 'pending' ? ('pending' as const) : ('inactive' as const), editable: canEdit },
    },
  }));
  return (
    <div className="grid gap-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Active" value={tally.active ?? 0} hint="Reach companies whose plan includes them" />
        <Stat label="Switched off" value={tally.off ?? 0} hint="Off for every company" />
        <Stat label="Pending" value={tally.pending ?? 0} hint="New, waiting for you to activate" />
      </div>
      <Card>
        <CardBody>
          <FeatureSwitchBoard
            rows={board}
            columns={COLUMN}
            busy={pending}
            onChange={change}
            intro={flash ? <Alert tone={flash.tone}>{flash.text}</Alert> : !canEdit ? <Alert tone="info">You can look at feature states. Changing them needs the access management capability.</Alert> : undefined}
          />
        </CardBody>
      </Card>
    </div>
  );
}
