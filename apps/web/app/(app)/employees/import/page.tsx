import { EMPLOYEE_IMPORT_COLUMNS, IMPORT_MAX_ROWS, LEAVE_COLUMN_PREFIX } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { Me } from '@/lib/types';
import { ImportView } from './import-view';

export const metadata: Metadata = { title: 'Import existing employees' };

export default async function ImportPage() {
  const me = await load<Me>('/me');
  return (
    <>
      <PageHeader title="Import existing employees" description={`Add people already working here from a spreadsheet, with their own employee IDs, original joining dates, reporting managers, leave balances and the assets they hold. Up to ${IMPORT_MAX_ROWS} people at a time.`} />
      <ImportView columns={EMPLOYEE_IMPORT_COLUMNS.map((c) => ({ ...c }))} leavePrefix={LEAVE_COLUMN_PREFIX} assets={me.features.includes('asset_management')} />
    </>
  );
}
