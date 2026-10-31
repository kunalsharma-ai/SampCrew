import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { LegalEntity } from '@/lib/types';
import type { Component, ExpenseCategory, StatutoryResponse, Structure } from '../../payroll/types';
import { PayrollSettingsView } from './payroll-settings-view';

export const metadata: Metadata = { title: 'Payroll settings' };

export default async function PayrollSettingsPage() {
  const [statutory, components, structures, categories, entities] = await Promise.all([
    load<StatutoryResponse>('/payroll/statutory'),
    load<Component[]>('/payroll/components'),
    load<Structure[]>('/payroll/structures'),
    load<ExpenseCategory[]>('/expenses/categories?includeArchived=false'),
    load<LegalEntity[]>('/org/legal-entities'),
  ]);
  return (
    <>
      <PageHeader title="Payroll settings" description="Statutory rates per legal entity, pay components, salary structures and expense categories." />
      <PayrollSettingsView statutory={statutory} components={components} structures={structures} categories={categories} entities={entities} />
    </>
  );
}
