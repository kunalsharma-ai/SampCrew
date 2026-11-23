import { WELCOME_SCENE_COOKIE, pickWelcomeScene } from '@crew/contracts';
import { SignInFrame } from '@crew/ui';
import { cookies } from 'next/headers';
import { Suspense } from 'react';
import { AuthShell } from './welcome';

/**
 * Sign-in, sign-up, password reset and invitations: the level's animated SampCrew welcome and greeting beside the
 * sign-in card (above it on phones and tablets), the whole page in that workspace's colours, with light and dark and
 * colour palettes to try. The form never waits for the animation.
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const remembered = (await cookies()).get(WELCOME_SCENE_COOKIE)?.value ?? null;
  const footer = <>© {new Date().getFullYear()} SAMPLEDGE · Isolated per company, multi-factor sign-in, tamper-evident audit trail</>;
  return (
    <Suspense fallback={<SignInFrame scene={pickWelcomeScene(null, remembered)} footer={footer} helpHref="/help-and-support">{children}</SignInFrame>}>
      <AuthShell remembered={remembered} footer={footer}>{children}</AuthShell>
    </Suspense>
  );
}
