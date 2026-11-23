import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { CrmShell } from '../crm-shell';
import type { CrmContext, CrmField } from '../crm-types';
import { FieldsManager } from './fields-manager';

export const metadata: Metadata = { title: 'Custom Fields · Candidate CRM' };

export default async function CrmFieldsPage() {
  const [ctx, data] = await Promise.all([
    load<CrmContext>('/recruitment/crm/context'),
    load<{ fields: CrmField[]; canCreate: boolean; owners: { id: string | null; name: string }[] }>('/recruitment/crm/fields'),
  ]);
  return (
    <CrmShell ctx={ctx} current="/recruitment/crm/fields" title="Custom Fields" description="Add your own questions to the candidate form, profile, filters, import and export. No change to SampCrew is needed.">
      <FieldsManager fields={data.fields} canCreate={data.canCreate} owners={data.owners} />
    </CrmShell>
  );
}
