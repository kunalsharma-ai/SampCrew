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
import { m0060DataImport } from './0060_data_import';
import { m0070LearningModules } from './0070_learning_modules';
import { m0080LearningNotifications } from './0080_learning_notifications';
import { m0081ConsoleAlertsSeen } from './0081_console_alerts_seen';
import { m0100DocumentCenter } from './0100_document_center';
import { m0110CandidateCrm } from './0110_candidate_crm';
import { m0130WorkspaceLimits } from './0130_workspace_limits';
import { m0140HelpCentre } from './0140_help_centre';
import { m0150ConsoleCommandCenter } from './0150_console_command_center';
import { m0160SimpleLeavePermissions } from './0160_simple_leave_permissions';
import { m0170NotificationFramework } from './0170_notification_framework';
import { m0180DeletePermissions } from './0180_delete_permissions';
import { m0190WorkModeAttendance } from './0190_work_mode_attendance';
import { m0200Feedback25Nov } from './0200_feedback_25_nov';
import { m0210OnboardingDocuments } from './0210_onboarding_documents';
import { m0230CareerEnquiry } from './0230_career_enquiry';

/** Every MongoDB migration, in order. Append new ones; never edit or reorder one that has shipped. */
export const MONGO_MIGRATIONS: MongoMigration[] = [
  m0001Foundation,
  m0002PlatformAdminPasswordChange,
  m0020EmployeeWorkspacePermissions,
  m0030NotificationCenter,
  m0031ApprovalCategories,
  m0032AnnouncementsUpgrade,
  m0033LeaveUpgrade,
  m0034RewardPayouts,
  m0035FeatureManagement,
  m0040LeaveRebuild,
  m0060DataImport,
  m0070LearningModules,
  m0080LearningNotifications,
  m0081ConsoleAlertsSeen,
  m0100DocumentCenter,
  m0110CandidateCrm,
  m0130WorkspaceLimits,
  m0140HelpCentre,
  m0150ConsoleCommandCenter,
  m0160SimpleLeavePermissions,
  m0170NotificationFramework,
  m0180DeletePermissions,
  m0190WorkModeAttendance,
  m0200Feedback25Nov,
  m0210OnboardingDocuments,
  m0230CareerEnquiry,
];
