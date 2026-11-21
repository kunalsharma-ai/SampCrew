'use client';
import { ForgotPasswordForm } from '@crew/ui';
import { completePasswordResetAction, requestPasswordResetAction } from '../auth-actions';

export function ForgotView() {
  return (
    <ForgotPasswordForm
      request={requestPasswordResetAction}
      complete={completePasswordResetAction}
      signInHref="/login"
      heading="Forgot your Console password?"
      intro="Enter your Console Admin email. We email you a link and a 6-digit code. Your authenticator code is still asked when you sign in."
    />
  );
}
