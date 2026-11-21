import type { MobileAppConfig, MobileConfigIssue } from '@crew/contracts';

export interface MobileAppOverview {
  catalogue: { key: string; available: boolean }[];
  published: { config: MobileAppConfig; version: number; publishedAt: string | null; publishedBy: string | null };
  draft: { config: MobileAppConfig; revision: number; updatedAt: string | null; updatedBy: string | null; changes: string[]; issues: MobileConfigIssue[] };
  stats: { totalModules: number; enabledModules: number; disabledModules: number; latestVersion: number; status: 'default' | 'draft_pending' | 'published' };
  /** People who used each module on a phone in the last 30 days. */
  usage: Record<string, number>;
}
