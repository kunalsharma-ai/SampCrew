import { LEAVE_AUTHORITY_LABELS } from '@crew/contracts';
import { Badge, Card, CardHeader, EmptyState } from '@crew/ui';
import type { LeaveMineType } from '@/lib/types';
import { byLine, policyLines } from './manage/policy-text';

/** The leave types this person holds, each with its rules, where applications go, and who set it up for them. */
export function MyLeaveTypes({ types }: { types: LeaveMineType[] }) {
  return (
    <Card>
      <CardHeader title="My leave types" description="The rules of each leave type you can apply for, where your applications go, and who created it and how many days you have." />
      {types.length ? (
        <div className="grid gap-4 p-5 pt-0 md:grid-cols-2" data-testid="my-leave-types">
          {types.map((t) => (
            <section key={t.leaveTypeId} className="rounded-lg border border-border p-4" aria-label={t.name}>
              <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                <span className="size-2.5 rounded-full" style={{ background: t.color }} />{t.name}<Badge>{t.code}</Badge>
              </h3>
              {t.description && <p className="mt-1 text-xs text-fg-muted">{t.description}</p>}
              <ul className="mt-3 grid gap-1 text-xs">
                {policyLines({ policy: t.policy, allowHalfDay: t.allowHalfDay, countsCalendarDays: t.countsCalendarDays, paid: t.paid }).map((l) => <li key={l}>{l}</li>)}
              </ul>
              <dl className="mt-3 grid gap-1 text-xs">
                <div><dt className="inline text-fg-subtle">Applications go to: </dt><dd className="inline">
                  {t.approval.routes.map((r) => LEAVE_AUTHORITY_LABELS[r.route]).join(' or ')}
                  {t.approval.employeeChooses ? ' (you choose)' : ''}
                  {t.approval.routes.length === 1 && t.approval.routes[0]!.route === 'both' ? `, ${t.approval.order === 'sequential' ? 'one after the other' : 'at the same time'}` : ''}
                  {t.approval.managerFirst ? ', after your reporting manager' : ''}
                </dd></div>
                <div><dt className="inline text-fg-subtle">Managed by: </dt><dd className="inline">{t.managedBy}</dd></div>
                <div><dt className="inline text-fg-subtle">Created by: </dt><dd className="inline">{byLine(t.createdBy)}</dd></div>
                <div><dt className="inline text-fg-subtle">Your quantity for {new Date().getFullYear()}: </dt><dd className="inline" data-testid="my-quantity">{t.notAssigned ? 'Not Assigned' : `${t.assigned} days, ${t.balance} left`}</dd></div>
              </dl>
            </section>
          ))}
        </div>
      ) : <EmptyState title="No leave types apply to you yet" description="A leave type shows here as soon as the Super Workspace or your HR Workspace makes it visible to you." />}
    </Card>
  );
}
