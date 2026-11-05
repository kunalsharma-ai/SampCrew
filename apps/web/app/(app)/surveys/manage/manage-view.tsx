'use client';
import { Badge, Button, Card, CardHeader, EmptyState, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { ClipboardList, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { Department, LegalEntity } from '@/lib/types';
import { SURVEY_STATUS, SURVEY_TONE } from '../../talent/labels';
import type { SurveySummary } from '../../talent/types';
import { SurveyDialog } from './survey-dialog';

export function ManageSurveysView({ surveys, entities, departments }: { surveys: SurveySummary[]; entities: LegalEntity[]; departments: Department[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Card>
        <CardHeader title="Surveys" action={<Button size="sm" onClick={() => setOpen(true)}><Plus className="size-3.5" /> New survey</Button>} />
        {surveys.length ? (
          <Table>
            <THead><tr><TH>Survey</TH><TH>Audience</TH><TH>Status</TH><TH className="text-right">Answered</TH><TH>Threshold</TH></tr></THead>
            <TBody>
              {surveys.map((s) => (
                <TR key={s.id}>
                  <TD><Link className="font-medium text-accent hover:underline" href={`/surveys/manage/${s.id}`}>{s.title}</Link><div className="text-xs text-fg-muted">{s.questions} questions{s.closesOn ? ` · closes ${s.closesOn}` : ''}</div></TD>
                  <TD className="text-fg-muted">{[s.legalEntityName, s.departmentName].filter(Boolean).join(' · ') || 'Everyone'}</TD>
                  <TD><Badge tone={SURVEY_TONE[s.status]} dot>{SURVEY_STATUS[s.status]}</Badge></TD>
                  <TD className="text-right tabular-nums">{s.status === 'draft' ? '–' : `${s.responded} of ${s.invited}`}</TD>
                  <TD className="text-fg-muted">{s.minResponses} answers</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState icon={<ClipboardList className="size-5" />} title="No surveys yet" description="Start with the pulse template and adjust the questions." />}
      </Card>
      <SurveyDialog open={open} onClose={() => setOpen(false)} entities={entities} departments={departments} />
    </>
  );
}
