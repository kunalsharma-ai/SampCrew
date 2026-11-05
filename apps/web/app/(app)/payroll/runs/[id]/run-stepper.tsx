import { cn } from '@crew/ui';
import { Check } from 'lucide-react';
import type { PayrollChecks } from '../../../insights/types';
import { amount } from '../../labels';
import type { PayrollRunDetail } from '../../types';

type State = 'done' | 'current' | 'todo' | 'stopped';
interface Step { key: string; title: string; detail: string; state: State; tone?: 'warning' }

/**
 * Where a payroll run is, from its real state: period, inputs, compute, review, approval, publish. The current step
 * says what to do next; the buttons for it are on the run card below.
 */
export function steps(run: PayrollRunDetail, checks: PayrollChecks | null): Step[] {
  const s = run.status;
  const computed = s !== 'draft' && s !== 'cancelled';
  const order = ['draft', 'computed', 'pending_approval', 'finalised'];
  const at = s === 'cancelled' ? -1 : order.indexOf(s);
  const state = (doneFrom: number, currentAt: number): State => (s === 'cancelled' ? 'stopped' : at >= doneFrom ? 'done' : at === currentAt ? 'current' : 'todo');
  const onHold = run.items.filter((i) => i.status === 'on_hold').length;
  const money = (v: string) => amount(v, run.currency);
  const flagged = checks?.flagged ?? 0;
  return [
    { key: 'period', title: 'Period', detail: `${run.periodStart} to ${run.periodEnd}, paid ${run.payDate}`, state: s === 'cancelled' ? 'stopped' : 'done' },
    {
      key: 'inputs', title: 'Inputs',
      detail: `${run.adjustments.length} adjustment${run.adjustments.length === 1 ? '' : 's'}${run.lopSource ? `, unpaid days from ${run.lopSource.replace(/_/g, ' ')}` : ''}`,
      state: state(1, 0),
    },
    {
      key: 'compute', title: 'Compute',
      detail: computed ? `${run.employeeCount} people, net ${money(run.net)}` : 'Work out pay for everyone with a salary',
      state: state(1, 0),
    },
    {
      key: 'review', title: 'Review',
      detail: computed
        ? [flagged ? `${flagged} payslip${flagged === 1 ? '' : 's'} flagged` : 'No payslip flagged', run.warnings.length ? `${run.warnings.length} warning${run.warnings.length === 1 ? '' : 's'}` : null, onHold ? `${onHold} on hold` : null].filter(Boolean).join(', ')
        : 'Checks against earlier months',
      state: state(2, 1),
      tone: computed && s === 'computed' && (flagged > 0 || onHold > 0) ? 'warning' : undefined,
    },
    { key: 'approve', title: 'Approval', detail: s === 'pending_approval' ? 'Waiting for Finance' : at >= 3 ? 'Approved' : 'Finance approves the totals', state: state(3, 2) },
    {
      key: 'publish', title: 'Publish',
      detail: s === 'finalised' ? `Payslips out${run.finalisedAt ? ` ${new Date(run.finalisedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}, bank file ready` : 'Payslips, bank file, attendance locked',
      state: state(3, 99),
    },
  ];
}

const NEXT: Record<string, string> = {
  draft: 'Next: add any adjustments, then compute payroll.',
  computed: 'Next: look at the flagged payslips and warnings, recompute after changes, then send for approval.',
  pending_approval: 'Next: a Finance approver approves the totals in Approvals; that finalises the run.',
  finalised: 'Done: payslips are published and the bank file can be downloaded.',
  cancelled: 'This run was cancelled.',
};

export function RunStepper({ run, checks }: { run: PayrollRunDetail; checks: PayrollChecks | null }) {
  const list = steps(run, checks);
  return (
    <nav aria-label="Payroll steps" className="rounded-xl border border-border bg-surface p-4 shadow-card">
      <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {list.map((st, i) => (
          <li key={st.key} aria-current={st.state === 'current' ? 'step' : undefined} aria-label={`${st.title}: ${st.state === 'done' ? 'done' : st.state === 'current' ? 'current step' : st.state === 'stopped' ? 'stopped' : 'not started'}`} className="flex gap-2.5">
            <span
              className={cn(
                'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                st.state === 'done' && 'bg-success text-white',
                st.state === 'current' && (st.tone === 'warning' ? 'bg-warning text-white ring-4 ring-warning/20' : 'bg-accent text-accent-fg ring-4 ring-accent/20'),
                (st.state === 'todo' || st.state === 'stopped') && 'border border-border text-fg-subtle',
              )}
              aria-hidden
            >
              {st.state === 'done' ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span className="min-w-0">
              <span className={cn('block text-[0.8125rem] font-medium', st.state === 'todo' && 'text-fg-muted')}>{st.title}</span>
              <span className={cn('block text-xs', st.tone === 'warning' ? 'text-warning' : 'text-fg-subtle')}>{st.detail}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-3 border-t border-border pt-3 text-[0.8125rem] text-fg-muted" role="status">{NEXT[run.status] ?? ''}</p>
    </nav>
  );
}
