import { Alert, Badge, Card, CardBody, CardHeader } from '@crew/ui';
import Link from 'next/link';
import type { PayrollChecks } from '../../../insights/types';

const TONE = { danger: 'danger', warning: 'warning', info: 'neutral' } as const;

/** Advisory checks: each person's pay against their own last finalised months. Nothing is changed. */
export function PayChecks({ runId, checks, finalised }: { runId: string; checks: PayrollChecks; finalised: boolean }) {
  return (
    <Card>
      <CardHeader
        title={finalised ? 'Checks' : 'Checks before approval'}
        description={`${checks.checked} payslips compared with each person's last three finalised months. Changes of more than ${checks.thresholdPct}% and unusual amounts are flagged for a second look; nothing is changed.`}
      />
      <CardBody className="grid gap-3 text-[13px]">
        {checks.flagged === 0 ? (
          <Alert tone="success">No payslip needs a second look.</Alert>
        ) : (
          <Alert tone="warning">{checks.flagged} payslip{checks.flagged === 1 ? '' : 's'} to look at before {finalised ? 'the next run' : 'approving'}.</Alert>
        )}
        {checks.people.map((p) => (
          <div key={p.itemId} className="border-t border-border pt-3 first:border-0 first:pt-0">
            <Link className="font-medium text-accent hover:underline" href={`/payroll/runs/${runId}/items/${p.itemId}`}>{p.name}</Link>
            <span className="ml-2 text-xs text-fg-subtle">{p.months ? `${p.months} earlier month${p.months === 1 ? '' : 's'}` : 'no earlier months'}</span>
            <ul className="mt-1 grid gap-1">
              {p.anomalies.map((a) => <li key={a.code} className="flex gap-2"><Badge tone={TONE[a.severity]}>{a.severity === 'danger' ? 'Check' : a.severity === 'warning' ? 'Review' : 'Note'}</Badge><span>{a.message}</span></li>)}
            </ul>
          </div>
        ))}
      </CardBody>
    </Card>
  );
}
