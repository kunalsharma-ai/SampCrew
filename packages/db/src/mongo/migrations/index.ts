import type { MongoMigration } from '../migrator';
import { m0001Foundation } from './0001_foundation';
import { m0002PlatformAdminPasswordChange } from './0002_platform_admin_password_change';
import { m0020EmployeeWorkspacePermissions } from './0020_employee_workspace_permissions';
import { m0030NotificationCenter } from './0030_notification_center';
import { m0031ApprovalCategories } from './0031_approval_categories';
import { m0032AnnouncementsUpgrade } from './0032_announcements_upgrade';
import { m0033LeaveUpgrade } from './0033_leave_upgrade';
import { m0034RewardPayouts } from './0034_reward_payouts';
import { m0035FeatureManagement } from './0035_feature_management';
import { m0040LeaveRebuild } from './0040_leave_rebuild';

/** Every MongoDB migration, in order. Append new ones; never edit or reorder one that has shipped. */
export const MONGO_MIGRATIONS: MongoMigration[] = [m0001Foundation, m0002PlatformAdminPasswordChange, m0020EmployeeWorkspacePermissions, m0030NotificationCenter, m0031ApprovalCategories, m0032AnnouncementsUpgrade, m0033LeaveUpgrade, m0034RewardPayouts, m0035FeatureManagement, m0040LeaveRebuild];
import { m0110CandidateCrm } from './0110_candidate_crm';

/** Every MongoDB migration, in order. Append new ones; never edit or reorder one that has shipped. */
export const MONGO_MIGRATIONS: MongoMigration[] = [m0001Foundation, m0002PlatformAdminPasswordChange, m0020EmployeeWorkspacePermissions, m0030NotificationCenter, m0031ApprovalCategories, m0032AnnouncementsUpgrade, m0033LeaveUpgrade, m0034RewardPayouts, m0035FeatureManagement, m0110CandidateCrm];
import { m0130WorkspaceLimits } from './0130_workspace_limits';

/** Every MongoDB migration, in order. Append new ones; never edit or reorder one that has shipped. */
export const MONGO_MIGRATIONS: MongoMigration[] = [m0001Foundation, m0002PlatformAdminPasswordChange, m0020EmployeeWorkspacePermissions, m0030NotificationCenter, m0031ApprovalCategories, m0032AnnouncementsUpgrade, m0033LeaveUpgrade, m0034RewardPayouts, m0035FeatureManagement, m0130WorkspaceLimits];
