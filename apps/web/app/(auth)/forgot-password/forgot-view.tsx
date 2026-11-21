'use client';
import { ForgotPasswordForm } from '@crew/ui';
import { completePasswordResetAction, requestPasswordResetAction } from '../actions';

/** For every level that signs in to the Web Portal: Super Workspace, HR Workspace and Employee Workspace. */
export function ForgotView() {
  return <ForgotPasswordForm request={requestPasswordResetAction} complete={completePasswordResetAction} signInHref="/login" />;
}
