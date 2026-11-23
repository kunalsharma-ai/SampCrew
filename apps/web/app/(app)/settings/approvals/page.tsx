import { PageHeader } from '@crew/ui';
import Link from 'next/link';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import type { LeaveType, Role } from '@/lib/types';
import { ApprovalChainEditor } from '@/components/approval-chain-editor';
import { CategoriesEditor, type CategoryRow } from './categories-editor';

export const metadata: Metadata = { title: 'Approval settings' };

interface TypeRow { resourceType: string; label: string; canConfigure: boolean; setByModule?: string | null; fallbackRole: string; steps: { type: string; role?: string }[] | null; autoApproveSoleOwner: boolean }

export default async function ApprovalSettingsPage() {
  const [types, categories, roles, leaveTypes, expenseCategories] = await Promise.all([
    load<TypeRow[]>('/approvals/types'),
    load<CategoryRow[]>('/approvals/categories'),
    loadOptional<Role[]>('/roles'),
    loadOptional<LeaveType[]>('/leave/types'),
    loadOptional<{ id: string; name: string }[]>('/expenses/categories'),
  ]);
  const configurable = types.filter((t) => t.canConfigure && t.steps);
  return (
    <>
      <PageHeader title="Approval settings" description="Who approves each kind of request, in what order, and how requests are grouped into cards on the Approvals page. Changes are audited." />
      <div className="grid gap-6">
        <CategoriesEditor categories={categories} types={types.map((t) => ({ key: t.resourceType, label: t.label }))} leaveTypes={(leaveTypes ?? []).map((l) => ({ code: l.code, name: l.name }))} expenseCategories={expenseCategories ?? []} />
        <section className="grid gap-4" aria-label="Approval chains">
          <h2 className="text-sm font-semibold">Approval chains</h2>
          {types.filter((t) => t.setByModule).map((t) => (
            <p key={t.resourceType} className="text-[0.8125rem] text-fg-muted" data-testid={`chain-set-by-module-${t.resourceType}`}>
              <span className="font-medium text-fg">{t.label}:</span> {t.setByModule}{t.resourceType === 'leave_request' && <> <Link className="text-accent hover:underline" href="/leave/manage?tab=types">Open leave types</Link></>}
            </p>
          ))}
          {configurable.length === 0 && <p className="text-[0.8125rem] text-fg-muted">You cannot change any approval chain. Ask a workspace owner.</p>}
          <div className="grid gap-4 xl:grid-cols-2">
            {configurable.map((t) => (
              <ApprovalChainEditor key={t.resourceType} resourceType={t.resourceType} title={t.label} steps={t.steps!} fallbackRole={t.fallbackRole} roles={roles ?? []}
                note={t.autoApproveSoleOwner ? 'When the only Owner of the workspace raises one and nobody else can approve it, it is approved automatically and recorded in the audit trail.' : undefined} />
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
