import { BGV_STATUS_LABEL } from '@crew/contracts';
import { Badge, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import { STATUS_TONE } from '../labels';
import type { Agency, CaseDetail, Verifier } from '../types';
import { CaseView } from './case-view';
import { CustomFieldsCard, type FieldValue } from '@/components/custom-fields-card';

export const metadata: Metadata = { title: 'Verification case' };

export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await load<CaseDetail>(`/bgv/cases/${id}`);
  const [agencies, verifiers, fields] = await Promise.all([
    loadOptional<Agency[]>('/bgv/agencies'),
    c.can.edit ? loadOptional<Verifier[]>('/bgv/verifiers') : Promise.resolve(null),
    loadOptional<FieldValue[]>(`/custom-fields/values/bgv_case/${id}`),
  ]);
  return (
    <>
      <PageHeader
        eyebrow={<span className="font-mono">{c.reference}</span>}
        title={<span className="flex flex-wrap items-center gap-3">{c.employee.name}<Badge tone={STATUS_TONE[c.status]}>{BGV_STATUS_LABEL[c.status as keyof typeof BGV_STATUS_LABEL] ?? c.status}</Badge></span>}
        description={[c.employee.code, c.employee.designation, c.employee.department].filter(Boolean).join(' · ') || undefined}
      />
      <CaseView c={c} agencies={(agencies ?? []).filter((a) => a.active)} verifiers={verifiers ?? []} />
      {fields && fields.length > 0 && <div className="mt-6"><CustomFieldsCard entity="bgv_case" recordId={id} initial={fields} path={`/verification/${id}`} /></div>}
    </>
  );
}
