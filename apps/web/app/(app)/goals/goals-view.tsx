'use client';
import { Badge, Button, Card, CardHeader, EmptyState, Stat, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Plus, Target } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { CONFIDENCE, CONFIDENCE_TONE, GOAL_STATUS, GOAL_TONE } from '../talent/labels';
import { Progress } from '../talent/progress';
import type { Alignable, Goal } from '../talent/types';
import { GoalDialog } from './goal-form';

export function GoalsView({ view, goals, overall, alignable, people, manages }: {
  view: 'mine' | 'team'; goals: Goal[]; overall: number | null; alignable: Alignable[]; people: { id: string; name: string }[]; manages: boolean;
}) {
  const [open, setOpen] = useState(false);
  const active = goals.filter((g) => g.status === 'active');
  const risky = active.filter((g) => g.confidence && g.confidence !== 'on_track').length;
  const tabs = [{ v: 'mine', l: 'My goals' }, ...(manages ? [{ v: 'team', l: 'My team' }] : [])];
  return (
    <div className="grid gap-6">
      {tabs.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {tabs.map((t) => (
            <Link key={t.v} href={t.v === 'mine' ? '/goals' : '/goals?view=team'} className={`rounded-full px-3 py-1 text-[13px] font-medium ${view === t.v ? 'bg-accent text-accent-fg' : 'bg-bg-subtle text-fg-muted hover:text-fg'}`}>{t.l}</Link>
          ))}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Active goals" value={active.length} hint={view === 'team' ? 'Across your team' : undefined} />
        <Stat label={view === 'mine' ? 'Overall progress' : 'Average progress'} value={`${view === 'mine' ? overall ?? 0 : active.length ? Math.round(active.reduce((a, g) => a + g.progress, 0) / active.length) : 0}%`} hint={view === 'mine' ? 'Weighted by goal weight' : undefined} />
        <Stat label="At risk or off track" value={risky} hint="From the latest check-ins" />
      </div>
      <Card>
        <CardHeader title={view === 'mine' ? 'My goals' : "My team's goals"} action={<Button size="sm" onClick={() => setOpen(true)}><Plus className="size-3.5" /> New goal</Button>} />
        {goals.length ? (
          <Table>
            <THead><tr>{view === 'team' && <TH>Person</TH>}<TH>Goal</TH><TH>Period</TH><TH className="w-56">Progress</TH><TH>Confidence</TH><TH>Status</TH></tr></THead>
            <TBody>
              {goals.map((g) => (
                <TR key={g.id}>
                  {view === 'team' && <TD className="whitespace-nowrap">{g.employeeName}</TD>}
                  <TD>
                    <Link className="font-medium text-accent hover:underline" href={`/goals/${g.id}`}>{g.title}</Link>
                    <div className="text-xs text-fg-muted">{g.keyResultCount ? `${g.keyResultCount} key result${g.keyResultCount === 1 ? '' : 's'}` : 'Progress reported directly'}{g.weight ? ` · weight ${g.weight}%` : ''}</div>
                  </TD>
                  <TD className="whitespace-nowrap text-fg-muted">{g.periodStart} to {g.periodEnd}</TD>
                  <TD><Progress value={g.progress} tone={g.confidence === 'off_track' ? 'danger' : g.confidence === 'at_risk' ? 'warning' : 'accent'} /></TD>
                  <TD>{g.confidence ? <Badge tone={CONFIDENCE_TONE[g.confidence]} dot>{CONFIDENCE[g.confidence]}</Badge> : <span className="text-xs text-fg-muted">No check-in yet</span>}</TD>
                  <TD><Badge tone={GOAL_TONE[g.status]}>{GOAL_STATUS[g.status]}</Badge></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <EmptyState icon={<Target className="size-5" />} title={view === 'mine' ? 'No goals yet' : 'No goals for your team yet'} description="Add a goal with one or more key results, then update it with check-ins." />
        )}
      </Card>
      <GoalDialog open={open} onClose={() => setOpen(false)} alignable={alignable} people={people} />
    </div>
  );
}
