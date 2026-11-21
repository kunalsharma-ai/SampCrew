import { Alert } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { LearningAccessView, LearningOptions } from '../../types';
import { ModuleEditor } from '../module-editor';

export const metadata: Metadata = { title: 'New learning module' };

export default async function NewModulePage() {
  const [options, access] = await Promise.all([load<LearningOptions>('/learning/options'), load<LearningAccessView>('/learning/access')]);
  if (!access.caps.create) return <Alert tone="warning">Your Super Workspace has not let your HR Workspace create learning modules.</Alert>;
  return <ModuleEditor options={options} access={access} initial={null} />;
}
