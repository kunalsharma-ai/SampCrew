'use client';
import { ResetPasswordForm } from '@crew/ui';
import { completePasswordResetAction } from '../auth-actions';

export function ResetView({ token, maskedEmail }: { token: string; maskedEmail?: string }) {
  return <ResetPasswordForm token={token} maskedEmail={maskedEmail} complete={completePasswordResetAction} signInHref="/login" />;
}
