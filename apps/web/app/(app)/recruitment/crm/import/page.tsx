import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { CrmShell } from '../crm-shell';
import type { CrmContext } from '../crm-types';
import { type ImportHistory, ImportWizard } from './import-wizard';

export const metadata: Metadata = { title: 'Import · Candidate CRM' };

export default async function CrmImportPage() {
  const [ctx, history] = await Promise.all([load<CrmContext>('/recruitment/crm/context'), load<ImportHistory>('/recruitment/crm/imports')]);
  return (
    <CrmShell ctx={ctx} current="/recruitment/crm/import" title="Import candidates" description="Bring candidates in from an Excel (.xlsx) or CSV file: match the columns, check every row, then import.">
      <ImportWizard ctx={ctx} history={history} />
    </CrmShell>
  );
}
