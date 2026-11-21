import { Alert } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { LearningAccessView, LearningOptions, PermissionRow } from '../../types';
import { CategoriesCard, PermissionsGrid } from './settings-parts';

export const metadata: Metadata = { title: 'Learning permissions' };

export default async function LearningSettingsPage() {
  const access = await load<LearningAccessView>('/learning/access');
  if (access.level !== 'super') return <Alert tone="warning">Only the Super Workspace sets what HR Workspaces can do in Learning.</Alert>;
  const [rows, options] = await Promise.all([load<PermissionRow[]>('/learning/permissions'), load<LearningOptions>('/learning/options')]);
  return (
    <div className="grid gap-4">
      <PermissionsGrid rows={rows} />
      <CategoriesCard predefined={options.categories} custom={options.customCategories} />
    </div>
  );
}
