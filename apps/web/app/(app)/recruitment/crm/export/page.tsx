import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { CrmShell } from '../crm-shell';
import type { CrmContext, CrmList } from '../crm-types';
import { crmQuery, type CrmSearch, crmState } from '../crm-view-url';
import { type ExportData, ExportForm } from './export-form';

export const metadata: Metadata = { title: 'Export to Excel · Candidate CRM' };

export default async function CrmExportPage({ searchParams }: { searchParams: Promise<CrmSearch> }) {
  const sp = await searchParams;
  const filters = crmState(sp).filters ?? {};
  const qs = crmQuery({ filters });
  qs.set('limit', '1');
  const [ctx, data, matching] = await Promise.all([
    load<CrmContext>('/recruitment/crm/context'),
    load<ExportData>('/recruitment/crm/export/columns'),
    load<CrmList>(`/recruitment/crm/candidates?${qs}`),
  ]);
  return (
    <CrmShell ctx={ctx} current="/recruitment/crm/export" title="Export to Excel" description="Download candidates as an Excel or CSV file with the columns you choose. Every export is logged.">
      <ExportForm data={data} filters={filters} matching={matching.total} />
    </CrmShell>
  );
}
