import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import { allowed, ModuleOverview } from '@/components/module-overview';
import type { LegalEntity, Me } from '@/lib/types';
import { RunsView } from './runs-view';
import type { PayrollRun, StatutoryResponse } from './types';

export const metadata: Metadata = { title: 'Payroll' };

export default async function PayrollPage() {
  const [me, runs, entities, statutory] = await Promise.all([
    load<Me>('/me'),
    load<PayrollRun[]>('/payroll/runs'),
    loadOptional<LegalEntity[]>('/org/legal-entities'),
    loadOptional<StatutoryResponse>('/payroll/statutory'),
  ]);
  const configured = new Set((statutory?.settings ?? []).map((s) => s.legalEntityId));
  return (
    <>
      <PageHeader title="Payroll" description="Monthly payroll runs per legal entity. Compute, review every payslip, then send for approval; the approver finalises." />
      <ModuleOverview module="payroll" actions={allowed(me, [
        { label: 'Salaries', href: '/payroll/salaries', icon: 'banknote', permission: 'payroll:read' },
        { label: 'Pay slips', href: '/payslips', icon: 'file-text', permission: 'payslips:read' },
        { label: 'Expenses', href: '/expenses', icon: 'receipt', permission: 'expenses:submit', feature: 'expenses' },
        { label: 'Payroll settings', href: '/settings/payroll', icon: 'landmark', permission: 'payroll:configure' },
      ])} />
      <RunsView runs={runs} entities={entities ?? []} configured={[...configured]} canRun={Boolean(me.permissions['payroll:run'])} canConfigure={Boolean(me.permissions['payroll:configure'])} />
    </>
  );
}
