import { Badge, Card, CardHeader, EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load, loadOptional } from '@/lib/api';
import type { AppraisalCycle, AppraisalForm, Department } from '@/lib/types';
import { day } from '../../appraisal/appraisal-ui';
import { CycleDialog, FormRowActions, FormsToolbar } from './admin-ui';
import { flatDepartments } from './departments';

export const metadata: Metadata = { title: 'Appraisal forms & cycles' };

const AUDIENCE: Record<string, string> = { all: 'Everyone', managers: 'People managers', non_managers: 'Individual contributors' };
const CYCLE_TONE = { draft: 'neutral', active: 'accent', closed: 'success' } as const;

export default async function AppraisalSettingsPage() {
  const [{ forms, templates }, cycles, departments] = await Promise.all([
    load<{ forms: AppraisalForm[]; templates: { key: string; name: string; added: boolean }[] }>('/appraisals/forms'),
    load<AppraisalCycle[]>('/appraisals/cycles'),
    loadOptional<Department[]>('/org/departments'),
  ]);
  const depts = flatDepartments(departments);
  return (
    <>
      <PageHeader
        eyebrow={<Link href="/appraisal" className="hover:underline">Appraisal</Link>}
        title="Appraisal forms & cycles"
        description="Build the forms people fill in, then open a cycle to send them out. Each appraisal keeps a copy of its form, so edits here never change one already started."
      />
      <div className="grid gap-6">
        <Card>
          <CardHeader title="Appraisal forms" description="Sections, questions, weights, the rating scale, performance categories and how the final score is worked out." action={<FormsToolbar templates={templates} />} />
          {forms.length ? (
            <Table aria-label="Appraisal forms">
              <THead><tr><TH>Form</TH><TH>For</TH><TH>Sections</TH><TH>Version</TH><TH><span className="sr-only">Actions</span></TH></tr></THead>
              <TBody>
                {forms.map((f) => (
                  <TR key={f.id}>
                    <TD>
                      <Link className="font-medium text-accent hover:underline" href={`/settings/appraisals/forms/${f.id}`}>{f.name}</Link>
                      <div className="mt-1 flex flex-wrap gap-1">{f.isDefault && <Badge tone="accent">Default</Badge>}{!f.active && <Badge tone="neutral">Inactive</Badge>}</div>
                    </TD>
                    <TD>{AUDIENCE[f.audience] ?? f.audience}{f.departmentIds.length ? ` · ${f.departmentIds.length} departments` : ''}{f.designationIds.length ? ` · ${f.designationIds.length} designations` : ''}</TD>
                    <TD className="tabular">{f.definition.sections.filter((s) => s.active).length}</TD>
                    <TD className="tabular">v{f.version}</TD>
                    <TD><FormRowActions form={f} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : <EmptyState title="No forms yet" description="Start from the Frequent Research template or a blank form. You can change every part of it." />}
        </Card>
        <Card>
          <CardHeader title="Appraisal cycles" description="A cycle sends a form to people for a review period, with deadlines for each stage." action={forms.length ? <CycleDialog forms={forms.filter((f) => f.active)} departments={depts} /> : undefined} />
          {cycles.length ? (
            <Table aria-label="Appraisal cycles">
              <THead><tr><TH>Cycle</TH><TH>Status</TH><TH>Period</TH><TH>Self due</TH><TH>People</TH><TH>Done</TH></tr></THead>
              <TBody>
                {cycles.map((c) => (
                  <TR key={c.id}>
                    <TD><Link className="font-medium text-accent hover:underline" href={`/settings/appraisals/cycles/${c.id}`}>{c.name}</Link><div className="text-xs text-fg-subtle">{c.formName ?? 'Form by rules'}</div></TD>
                    <TD><Badge tone={CYCLE_TONE[c.status]} dot>{c.status === 'draft' ? 'Draft' : c.status === 'active' ? 'Running' : 'Closed'}</Badge></TD>
                    <TD>{day(c.periodStart)} to {day(c.periodEnd)}</TD>
                    <TD>{day(c.selfDue)}</TD>
                    <TD className="tabular">{c.participants}</TD>
                    <TD className="tabular">{(c.byStage.published ?? 0) + (c.byStage.finalized ?? 0)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : <EmptyState title="No cycles yet" description={forms.length ? 'Create a cycle to send a form to people.' : 'Add a form first.'} />}
        </Card>
      </div>
    </>
  );
}
