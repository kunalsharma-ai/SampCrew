import { Badge, buttonClass, Card, CardHeader, EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { ClipboardList } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import type { Me } from '@/lib/types';
import type { MySurvey } from '../talent/types';

export const metadata: Metadata = { title: 'Surveys' };

export default async function SurveysPage() {
  const [me, surveys] = await Promise.all([load<Me>('/me'), load<MySurvey[]>('/my-surveys')]);
  return (
    <>
      <PageHeader
        title="Surveys"
        description="Anonymous surveys from HR. Your answers are stored without your name, and results are shown only for groups large enough that nobody can be singled out."
        actions={me.permissions['engagement:manage'] ? <Link className={buttonClass('secondary', 'sm')} href="/surveys/manage">Manage surveys</Link> : undefined}
      />
      <Card>
        <CardHeader title="Your surveys" />
        {surveys.length ? (
          <Table>
            <THead><tr><TH>Survey</TH><TH>Closes</TH><TH>Status</TH><TH /></tr></THead>
            <TBody>
              {surveys.map((s) => (
                <TR key={s.id}>
                  <TD><div className="font-medium">{s.title}</div><div className="text-xs text-fg-muted">{s.questions} question{s.questions === 1 ? '' : 's'}</div></TD>
                  <TD className="text-fg-muted">{s.closesOn ?? 'No closing date'}</TD>
                  <TD>{s.responded ? <Badge tone="success" dot>Answered</Badge> : s.status === 'open' ? <Badge tone="warning" dot>Waiting for you</Badge> : <Badge>Closed</Badge>}</TD>
                  <TD className="text-right">{!s.responded && s.status === 'open' && <Link className="text-[0.8125rem] font-medium text-accent hover:underline" href={`/surveys/${s.id}`}>Answer</Link>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <EmptyState icon={<ClipboardList className="size-5" />} title="No surveys for you right now" description="When HR opens a survey for your group, it appears here." />
        )}
      </Card>
    </>
  );
}
