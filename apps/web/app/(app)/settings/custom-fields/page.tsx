import type { CustomFieldDefinition } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import type { Role } from '@/lib/types';
import { FieldsView } from './fields-view';

export const metadata: Metadata = { title: 'Custom fields' };

export type FieldRow = CustomFieldDefinition & { valueCount?: number };
export interface FieldHistory { id: string; action: string; fieldId: string | null; by: string | null; at: string; changes: unknown }

export default async function CustomFieldsPage({ searchParams }: { searchParams: Promise<{ entity?: string }> }) {
  const { entity } = await searchParams;
  const [fields, roles, history] = await Promise.all([load<FieldRow[]>('/custom-fields?archived=true'), loadOptional<Role[]>('/roles'), load<FieldHistory[]>('/custom-fields/history')]);
  return (
    <>
      <PageHeader title="Custom fields" description="Add your own fields to employee profiles, assets, background checks, candidates and leave requests. A field that holds data is archived, never deleted, and every change is recorded." />
      <FieldsView fields={fields} roles={(roles ?? []).map((r) => ({ key: r.key, name: r.name }))} history={history} entity={entity ?? 'employee'} />
    </>
  );
}
