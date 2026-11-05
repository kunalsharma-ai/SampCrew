import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { Me } from '@/lib/types';
import type { ExpenseCategory, ExpenseClaim } from '../payroll/types';
import { ExpensesView } from './expenses-view';

export const metadata: Metadata = { title: 'Expenses' };

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view: v } = await searchParams;
  const me = await load<Me>('/me');
  const canApprove = Boolean(me.permissions['expenses:approve']);
  const view = canApprove && (v === 'approvals' || v === 'all') ? v : 'mine';
  const [claims, categories] = await Promise.all([load<ExpenseClaim[]>(`/expenses/claims?view=${view}`), load<ExpenseCategory[]>('/expenses/categories')]);
  return (
    <>
      <PageHeader title="Expenses" description="Claim work expenses with a receipt. Approved claims are paid with your next salary, tax-free as reimbursements." />
      <ExpensesView view={view} claims={claims} categories={categories} canApprove={canApprove} canSubmit={Boolean(me.permissions['expenses:submit'])} currency={me.tenant.currency} />
    </>
  );
}
