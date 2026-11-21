import type { Metadata } from 'next';
import { AuthFrame } from '../auth-frame';
import { ForgotView } from './forgot-view';

export const metadata: Metadata = { title: 'Forgot password' };

export default function ConsoleForgotPasswordPage() {
  return (
    <AuthFrame>
      <ForgotView />
    </AuthFrame>
  );
}
